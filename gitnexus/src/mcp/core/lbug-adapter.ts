/**
 * LadybugDB Adapter (Connection Pool)
 *
 * Manages a pool of LadybugDB databases keyed by repoId, each with
 * multiple Connection objects for safe concurrent query execution.
 *
 * LadybugDB Connections are NOT thread-safe — a single Connection
 * segfaults if concurrent .query() calls hit it simultaneously.
 * This adapter provides a checkout/return connection pool so each
 * concurrent query gets its own Connection from the same Database.
 *
 * @see https://docs.ladybugdb.com/concurrency — multiple Connections
 * from the same Database is the officially supported concurrency pattern.
 */

import fs from 'fs/promises';
import lbug from '@ladybugdb/core';
import { dbLogger } from '../../util/logger.js';
import { isLocked, waitForLockRelease, getLockInfo } from '../../util/lockfile.js';

/** Per-repo pool: one Database, many Connections */
interface PoolEntry {
  db: lbug.Database;
  /** Available connections ready for checkout */
  available: lbug.Connection[];
  /** Number of connections currently checked out */
  checkedOut: number;
  /** Queued waiters for when all connections are busy */
  waiters: Array<(conn: lbug.Connection) => void>;
  lastUsed: number;
  dbPath: string;
  /** mtime of the DB file when this pool entry was created */
  openedAtMtime: number;
  /** Entry is draining — reject new checkouts, close DB when checkedOut hits 0 */
  draining?: boolean;
  /** Resolvers waiting for drain to complete */
  drainWaiters?: Array<() => void>;
}

const pool = new Map<string, PoolEntry>();

/**
 * Maps repoId -> dbPath for auto-recovery when pool entry is missing.
 * Persists across pool evictions so we can re-initialize automatically.
 */
const knownDbPaths = new Map<string, string>();

/**
 * Shared Database cache keyed by resolved dbPath.
 * Multiple repoIds pointing to the same path share one native Database
 * object to avoid exhausting the buffer manager's mmap budget.
 */
interface SharedDB {
  db: lbug.Database;
  refCount: number;
  ftsLoaded: boolean;
  /** mtime of the DB file when opened — used for staleness detection */
  openedAtMtime: number;
  /** Database is being closed — don't reuse, wait for closePromise */
  closing?: boolean;
  /** Resolves when the database has finished closing */
  closePromise?: Promise<void>;
}
const dbCache = new Map<string, SharedDB>();

/**
 * Pending initialization promises keyed by repoId.
 * Prevents concurrent initLbug calls for the same repo from racing.
 */
const pendingInits = new Map<string, Promise<void>>();

/** Max repos in the pool (LRU eviction) */
const MAX_POOL_SIZE = 5;
/** Idle timeout before closing a repo's connections */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** Max connections per repo (caps concurrent queries per repo) */
const MAX_CONNS_PER_REPO = 8;
/** Connections created eagerly on init */
const INITIAL_CONNS_PER_REPO = 2;

let idleTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Fast rebuild-lock watcher — polls every 100ms for rebuild locks on all known dbPaths.
 * When a lock is detected, immediately closes ALL pool entries to prevent native crashes.
 * This is critical because native code will segfault if files are deleted while open.
 */
let rebuildWatcherTimer: ReturnType<typeof setInterval> | null = null;

function startRebuildWatcher(): void {
  if (rebuildWatcherTimer) return;

  dbLogger.info('Starting rebuild-lock watcher (200ms polling)');

  rebuildWatcherTimer = setInterval(async () => {
    // Check all known dbPaths for rebuild locks
    for (const [repoId, dbPath] of knownDbPaths) {
      const lockPath = `${dbPath}.rebuild`;
      try {
        // Fast existence check — don't need full isLocked() which parses content
        await fs.stat(lockPath);
        // Lock exists — immediately close the pool to prevent native crash
        const entry = pool.get(repoId);
        if (entry) {
          // Sync log to stderr so it survives even if crash follows
          try { require('fs').writeSync(2, `[rebuild-watcher] Lock detected for ${repoId}, closing pool NOW\n`); } catch {}
          dbLogger.info({ repoId, dbPath }, 'Rebuild lock detected by watcher, closing pool proactively');
          await closeOne(repoId);
          dbLogger.info({ repoId }, 'Pool closed successfully by rebuild watcher');
        }
      } catch {
        // Lock doesn't exist — all good
      }
    }
  }, 200); // 200ms polling — gives ~300ms to close connections before analyze deletes files

  if (rebuildWatcherTimer && typeof rebuildWatcherTimer === 'object' && 'unref' in rebuildWatcherTimer) {
    (rebuildWatcherTimer as NodeJS.Timeout).unref();
  }
}

function stopRebuildWatcher(): void {
  if (rebuildWatcherTimer) {
    clearInterval(rebuildWatcherTimer);
    rebuildWatcherTimer = null;
  }
}

/** Saved real stdout.write — used to silence LadybugDB native output without race conditions */
const realStdoutWrite = process.stdout.write.bind(process.stdout);
let stdoutSilenceCount = 0;

/**
 * Start the idle cleanup timer (runs every 60s) and the rebuild watcher.
 */
function ensureIdleTimer(): void {
  // Start rebuild watcher first — this is critical for crash prevention
  startRebuildWatcher();

  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [repoId, entry] of pool) {
      if (now - entry.lastUsed > IDLE_TIMEOUT_MS && entry.checkedOut === 0) {
        closeOne(repoId);
      }
    }
  }, 60_000);
  if (idleTimer && typeof idleTimer === 'object' && 'unref' in idleTimer) {
    (idleTimer as NodeJS.Timeout).unref();
  }
}

/**
 * Evict the least-recently-used repo if pool is at capacity
 */
async function evictLRU(): Promise<void> {
  if (pool.size < MAX_POOL_SIZE) return;

  let oldestId: string | null = null;
  let oldestTime = Infinity;
  for (const [id, entry] of pool) {
    if (entry.checkedOut === 0 && entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldestId = id;
    }
  }
  if (oldestId) {
    await closeOne(oldestId);
  }
}

/**
 * Remove a repo from the pool and release its shared Database ref.
 * When refCount drops to 0, close the native Database handle to release
 * the file lock — otherwise `gitnexus analyze` and subsequent reopens
 * will fail with "Could not set lock on file".
 *
 * Uses async close() which works safely (unlike closeSync() which
 * segfaults via N-API destructor hooks on Linux/macOS).
 *
 * IMPORTANT: Waits for all checked-out connections to be returned before
 * closing the Database. This prevents "parent database is closed" errors
 * when queries are still in flight.
 */
async function closeOne(repoId: string): Promise<void> {
  const entry = pool.get(repoId);
  if (!entry) {
    pool.delete(repoId);
    return;
  }

  // Mark as draining — new checkouts will fail, checkin will resolve drain waiters
  entry.draining = true;

  // Remove from pool immediately so isLbugReady() returns false
  // and new operations will re-initialize rather than using stale entry
  const { dbPath } = entry;
  pool.delete(repoId);

  const shared = dbCache.get(dbPath);

  // Decrement refCount immediately and mark as closing if this is the last ref.
  // This prevents initLbug from reusing a database that's about to be closed.
  if (shared) {
    if (shared.refCount > 0) shared.refCount--;

    if (shared.refCount <= 0 && !shared.closing) {
      shared.closing = true;
      // Create close promise that initLbug can await if it runs during drain
      let resolveClose: () => void;
      shared.closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });

      // Perform the actual close after drain completes
      const doClose = async () => {
        // Wait for all checked-out connections to be returned
        if (entry.checkedOut > 0) {
          await new Promise<void>((resolve) => {
            entry.drainWaiters = entry.drainWaiters || [];
            entry.drainWaiters.push(resolve);
          });
        }

        dbCache.delete(dbPath);
        // Close connections and DB to release the file lock.
        for (const conn of entry.available) {
          try { await conn.close(); } catch (err) {
            dbLogger.warn({ err, dbPath }, 'Failed to close connection during pool drain');
          }
        }
        try { await shared.db.close(); } catch (err) {
          dbLogger.warn({ err, dbPath }, 'Failed to close database during pool drain');
        }
        resolveClose!();
      };

      await doClose();
      return;
    }
  }

  // refCount > 0 means other repos still use this DB — just wait for our drain
  if (entry.checkedOut > 0) {
    await new Promise<void>((resolve) => {
      entry.drainWaiters = entry.drainWaiters || [];
      entry.drainWaiters.push(resolve);
    });
  }
}

/**
 * Create a new Connection from a repo's Database.
 * Silences stdout to prevent native module output from corrupting MCP stdio.
 */
function silenceStdout(): void {
  if (stdoutSilenceCount++ === 0) {
    process.stdout.write = (() => true) as any;
  }
}

function restoreStdout(): void {
  if (--stdoutSilenceCount <= 0) {
    stdoutSilenceCount = 0;
    process.stdout.write = realStdoutWrite;
  }
}

function createConnection(db: lbug.Database): lbug.Connection {
  silenceStdout();
  try {
    return new lbug.Connection(db);
  } finally {
    restoreStdout();
  }
}

/** Query timeout in milliseconds */
const QUERY_TIMEOUT_MS = 30_000;
/** Waiter queue timeout in milliseconds */
const WAITER_TIMEOUT_MS = 15_000;

const LOCK_RETRY_ATTEMPTS = 3;
const LOCK_RETRY_DELAY_MS = 2000;

/**
 * Check if an error indicates the database connection is stale or corrupted.
 * This includes WAL corruption, closed database, and lock errors.
 * Used for recovery decisions across init, FTS load, and query execution.
 */
function isRecoverableDbError(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message;
  return (
    // WAL corruption patterns
    msg.includes('Corrupted wal') ||
    msg.includes('invalid WAL') ||
    msg.includes('Reading past the end of the file') ||
    // Database was closed (e.g., by analyze while we had a connection)
    msg.includes('parent database is closed') ||
    msg.includes('database is closed') ||
    // File was deleted/replaced
    msg.includes('ENOENT') ||
    msg.includes('no such file') ||
    // Lock conflicts (another process has the DB)
    msg.includes('Could not set lock')
  );
}

/**
 * Initialize (or reuse) a Database + connection pool for a specific repo.
 * Retries on lock errors (e.g., when `gitnexus analyze` is running).
 *
 * Concurrent calls for the same repoId are serialized to prevent race conditions
 * that could corrupt the WAL file or cause read errors.
 */
export const initLbug = async (repoId: string, dbPath: string): Promise<void> => {
  // Track dbPath for auto-recovery when pool entry is evicted
  knownDbPaths.set(repoId, dbPath);

  // If another init is in progress for this repo, wait for it instead of racing
  const pending = pendingInits.get(repoId);
  if (pending) {
    await pending;
    // After waiting, check if pool is now ready (the other caller succeeded)
    if (pool.get(repoId)) return;
    // Otherwise fall through to retry (the other caller may have failed)
  }

  // Fast path: already initialized and still fresh
  const existing = pool.get(repoId);
  if (existing) {
    let currentMtime: number;
    try {
      const stat = await fs.stat(dbPath);
      currentMtime = stat.mtimeMs;
    } catch {
      throw new Error(`LadybugDB not found at ${dbPath}. Run: gitnexus analyze`);
    }
    if (existing.openedAtMtime >= currentMtime) {
      existing.lastUsed = Date.now();
      return;
    }
    // Stale — will be closed and re-opened below
  }

  // Create init promise and register it
  const initPromise = doInitLbug(repoId, dbPath);
  pendingInits.set(repoId, initPromise);

  try {
    await initPromise;
  } finally {
    pendingInits.delete(repoId);
  }
};

/** Internal: performs the actual initialization (not concurrency-safe on its own) */
const doInitLbug = async (repoId: string, dbPath: string): Promise<void> => {
  // Wait for rebuild lock to be released (max 30 seconds)
  const rebuildLockPath = `${dbPath}.rebuild`;
  if (await isLocked(rebuildLockPath)) {
    dbLogger.info({ repoId, dbPath }, 'Waiting for rebuild to complete...');
    const released = await waitForLockRelease(rebuildLockPath, { maxWaitMs: 30_000 });
    if (!released) {
      throw new Error(`Rebuild lock timeout: database at ${dbPath} has been locked for over 30 seconds`);
    }
  }

  // Check if database exists and get its mtime
  let currentMtime: number;
  try {
    const stat = await fs.stat(dbPath);
    currentMtime = stat.mtimeMs;
  } catch {
    throw new Error(`LadybugDB not found at ${dbPath}. Run: gitnexus analyze`);
  }

  const existing = pool.get(repoId);
  if (existing) {
    // Staleness check: if the DB file was rewritten since we opened it,
    // close the stale connection and re-open with fresh data.
    if (existing.openedAtMtime < currentMtime) {
      await closeOne(repoId);
    } else {
      existing.lastUsed = Date.now();
      return;
    }
  }

  await evictLRU();

  // Reuse an existing native Database if another repoId already opened this path.
  // This prevents buffer manager exhaustion from multiple mmap regions on the same file.
  let shared = dbCache.get(dbPath);

  // If the shared db is being closed by closeOne, wait for it to finish
  if (shared?.closing && shared.closePromise) {
    await shared.closePromise;
    shared = undefined; // It's now closed, we need to create a new one
  }

  if (shared && shared.openedAtMtime < currentMtime) {
    // DB file was rewritten — close stale handle to release file lock
    dbCache.delete(dbPath);
    try { await shared.db.close(); } catch (err) {
      dbLogger.warn({ err, dbPath }, 'Failed to close stale database handle');
    }
    shared = undefined;
  }
  if (!shared) {
    // Open in read-only mode — MCP server never writes to the database.
    // This allows multiple MCP server instances to read concurrently, and
    // avoids lock conflicts when `gitnexus analyze` is writing.
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
      silenceStdout();
      try {
        const db = new lbug.Database(
          dbPath,
          0,     // bufferManagerSize (default)
          false, // enableCompression (default)
          true,  // readOnly
        );
        restoreStdout();
        shared = { db, refCount: 0, ftsLoaded: false, openedAtMtime: currentMtime };
        dbCache.set(dbPath, shared);
        break;
      } catch (err: any) {
        restoreStdout();
        lastError = err instanceof Error ? err : new Error(String(err));

        // WAL corruption: delete the .wal file and retry once.
        // The DB itself is intact — only uncommitted WAL entries are lost.
        const isWalCorrupt = lastError.message.includes('Corrupted wal')
          || lastError.message.includes('invalid WAL')
          || lastError.message.includes('Reading past the end of the file');
        if (isWalCorrupt) {
          dbLogger.warn({ err: lastError, dbPath }, 'WAL corruption detected, deleting WAL file');
          try { await fs.unlink(`${dbPath}.wal`); } catch (err) {
            dbLogger.warn({ err, dbPath }, 'Failed to delete corrupt WAL file');
          }
          continue; // retry with the .wal file removed
        }

        const isLockError = lastError.message.includes('Could not set lock')
          || lastError.message.includes('lock');
        if (!isLockError || attempt === LOCK_RETRY_ATTEMPTS) break;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS * attempt));
      }
    }

    if (!shared) {
      throw new Error(
        `LadybugDB unavailable for ${repoId}. Another process may be rebuilding the index. ` +
        `Retry later. (${lastError?.message || 'unknown error'})`
      );
    }
  }

  shared.refCount++;
  const db = shared.db;

  // Pre-create a small pool of connections
  const available: lbug.Connection[] = [];
  for (let i = 0; i < INITIAL_CONNS_PER_REPO; i++) {
    available.push(createConnection(db));
  }

  pool.set(repoId, { db, available, checkedOut: 0, waiters: [], lastUsed: Date.now(), dbPath, openedAtMtime: currentMtime });
  ensureIdleTimer();

  // Load FTS extension once per shared Database
  if (!shared.ftsLoaded) {
    try {
      await available[0].query('LOAD EXTENSION fts');
      shared.ftsLoaded = true;
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (isRecoverableDbError(errMsg)) {
        // Database corruption detected during FTS load — close pool and delete WAL so next init is clean
        dbLogger.warn({ err, dbPath }, 'Database corruption during FTS load, cleaning up');
        pool.delete(repoId);
        if (shared.refCount > 0) shared.refCount--;
        if (shared.refCount <= 0) {
          dbCache.delete(dbPath);
          for (const conn of available) {
            try { await conn.close(); } catch {}
          }
          try { await shared.db.close(); } catch {}
        }
        try { await fs.unlink(`${dbPath}.wal`); } catch {}
        // Re-throw so caller can retry — the pool is now clean
        throw new Error(`Database corruption during FTS load (cleaned up, retry will succeed): ${errMsg}`);
      }
      // Extension may not be installed — FTS queries will fail gracefully
      dbLogger.warn({ err, dbPath }, 'FTS extension not loaded (full-text search unavailable)');
    }
  }
};

/**
 * Checkout a connection from the pool.
 * Returns an available connection, or creates a new one if under the cap.
 * If all connections are busy and at cap, queues the caller until one is returned.
 * Rejects immediately if the entry is draining (closeOne in progress).
 */
function checkout(entry: PoolEntry): Promise<lbug.Connection> {
  // Sync log for crash debugging
  const logSync = (msg: string) => {
    try { require('fs').writeSync(2, `[checkout] ${msg}\n`); } catch {}
  };

  // Reject if draining — caller should re-init the DB
  if (entry.draining) {
    return Promise.reject(new Error('Connection pool is draining (database being closed). Retry the operation.'));
  }

  // Fast path: grab an available connection
  if (entry.available.length > 0) {
    logSync('reusing available connection');
    entry.checkedOut++;
    return Promise.resolve(entry.available.pop()!);
  }

  // Grow the pool if under the cap
  const totalConns = entry.available.length + entry.checkedOut;
  if (totalConns < MAX_CONNS_PER_REPO) {
    logSync('creating new connection');
    entry.checkedOut++;
    return Promise.resolve(createConnection(entry.db));
  }

  // At capacity — queue the caller with a timeout.
  return new Promise<lbug.Connection>((resolve, reject) => {
    const waiter = (conn: lbug.Connection) => {
      clearTimeout(timer);
      resolve(conn);
    };
    const timer = setTimeout(() => {
      const idx = entry.waiters.indexOf(waiter);
      if (idx !== -1) entry.waiters.splice(idx, 1);
      reject(new Error(`Connection pool exhausted: timed out after ${WAITER_TIMEOUT_MS}ms waiting for a free connection`));
    }, WAITER_TIMEOUT_MS);
    entry.waiters.push(waiter);
  });
}

/**
 * Return a connection to the pool after use.
 * If there are queued waiters, hand the connection directly to the next one
 * instead of putting it back in the available array (avoids race conditions).
 *
 * If the entry is draining (closeOne in progress), resolve drain waiters
 * when all connections have been returned.
 */
function checkin(entry: PoolEntry, conn: lbug.Connection): void {
  if (entry.draining) {
    // Entry is being closed — don't reuse the connection
    entry.checkedOut--;
    entry.available.push(conn); // Keep for closeOne to clean up
    if (entry.checkedOut <= 0 && entry.drainWaiters) {
      // All connections returned — notify closeOne to proceed
      for (const resolve of entry.drainWaiters) {
        resolve();
      }
      entry.drainWaiters = [];
    }
    return;
  }

  if (entry.waiters.length > 0) {
    // Hand directly to the next waiter — no intermediate available state
    const waiter = entry.waiters.shift()!;
    waiter(conn);
  } else {
    entry.checkedOut--;
    entry.available.push(conn);
  }
}

/**
 * Execute a query on a specific repo's connection pool.
 * Automatically checks out a connection, runs the query, and returns it.
 */
/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Detect database corruption/staleness and auto-recover by deleting the corrupt WAL
 * file, evicting the stale pool entry, and re-initializing the database.
 * Returns true if recovery succeeded and the caller should retry.
 */
async function recoverFromDbError(repoId: string, err: Error): Promise<boolean> {
  if (!isRecoverableDbError(err)) return false;

  const entry = pool.get(repoId);
  if (!entry) return false;

  const { dbPath } = entry;
  dbLogger.warn({ err, repoId, dbPath }, 'Database error detected during query, attempting recovery');
  await closeOne(repoId);
  // Delete WAL file if it exists — it may be corrupt or stale
  try { await fs.unlink(`${dbPath}.wal`); } catch {}
  try {
    await initLbug(repoId, dbPath);
    dbLogger.info({ repoId, dbPath }, 'Database recovery successful');
    return true;
  } catch (initErr) {
    dbLogger.warn({ err: initErr, repoId, dbPath }, 'Database recovery failed');
    return false;
  }
}

/**
 * Check if a rebuild is in progress for this database.
 * If lock is stale (>5 min and process dead), it's automatically removed.
 * If lock is fresh, close the pool to release file handles.
 */
async function checkRebuildLock(repoId: string, dbPath: string): Promise<boolean> {
  const lockPath = `${dbPath}.rebuild`;

  if (await isLocked(lockPath)) {
    const info = await getLockInfo(lockPath);
    dbLogger.info({ repoId, dbPath, lockInfo: info }, 'Rebuild lock detected, closing pool');
    await closeOne(repoId);
    return true;
  }

  return false;
}

/**
 * Pre-flight check: verify the database file still exists and hasn't been replaced.
 * If the file is gone or mtime changed, close the pool immediately to prevent native crash.
 * This is critical because LadybugDB native code will segfault if the file was deleted.
 */
async function preflightCheck(repoId: string, entry: PoolEntry): Promise<boolean> {
  // Sync log to stderr for crash debugging (logger may not flush before crash)
  const logSync = (msg: string) => {
    try { require('fs').writeSync(2, `[preflight] ${msg}\n`); } catch {}
  };

  logSync(`checking ${entry.dbPath}`);

  try {
    const stat = await fs.stat(entry.dbPath);
    if (stat.mtimeMs !== entry.openedAtMtime) {
      // File was modified/replaced — close pool before native code can crash
      logSync(`mtime changed: ${entry.openedAtMtime} -> ${stat.mtimeMs}, closing pool`);
      dbLogger.warn({ repoId, dbPath: entry.dbPath, oldMtime: entry.openedAtMtime, newMtime: stat.mtimeMs },
        'Database file changed, closing stale pool');
      await closeOne(repoId);
      return false;
    }
    logSync('OK');
    return true;
  } catch (err: any) {
    // File doesn't exist — close pool
    logSync(`file missing: ${err.message}, closing pool`);
    dbLogger.warn({ repoId, dbPath: entry.dbPath, err }, 'Database file missing, closing pool');
    await closeOne(repoId);
    return false;
  }
}

export const executeQuery = async (repoId: string, cypher: string): Promise<any[]> => {
  let entry = pool.get(repoId);

  // Auto-recover: if pool entry is missing but we know the dbPath, re-initialize
  if (!entry) {
    const dbPath = knownDbPaths.get(repoId);
    if (dbPath) {
      dbLogger.info({ repoId, dbPath }, 'Auto-recovering missing pool entry');
      await initLbug(repoId, dbPath);
      entry = pool.get(repoId);
    }
    if (!entry) {
      throw new Error(`LadybugDB not initialized for repo "${repoId}". Call initLbug first.`);
    }
  }

  // Check for rebuild lock before querying
  if (await checkRebuildLock(repoId, entry.dbPath)) {
    throw new Error('Database is being rebuilt. Retry the operation.');
  }

  // Pre-flight: verify DB file still exists and hasn't been replaced (prevents native crash)
  if (!(await preflightCheck(repoId, entry))) {
    // Pool was closed — retry with auto-recovery
    return executeQuery(repoId, cypher);
  }

  entry.lastUsed = Date.now();

  // Log query attempt for crash diagnostics
  dbLogger.debug({ repoId, query: cypher.slice(0, 100) }, 'Executing query');

  const conn = await checkout(entry);
  let result: any = null;
  try {
    const queryResult = await withTimeout(conn.query(cypher), QUERY_TIMEOUT_MS, 'Query');
    result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    const rows = await result.getAll();
    // Explicitly close result to prevent GC destructor hang (LadybugDB bug)
    try { result.close(); } catch {}
    result = null;
    return rows;
  } catch (err: any) {
    const error = err instanceof Error ? err : new Error(String(err));
    dbLogger.warn({ err: error, repoId }, 'Query failed');
    if (await recoverFromDbError(repoId, error)) {
      // Retry once after WAL recovery (original conn is dead, get a fresh one)
      return executeQuery(repoId, cypher);
    }
    throw error;
  } finally {
    // Always close result to prevent GC destructor hang
    if (result) { try { result.close(); } catch {} }
    checkin(entry, conn);
  }
};

/**
 * Execute a parameterized query on a specific repo's connection pool.
 * Uses prepare/execute pattern to prevent Cypher injection.
 */
export const executeParameterized = async (
  repoId: string,
  cypher: string,
  params: Record<string, any>,
): Promise<any[]> => {
  let entry = pool.get(repoId);

  // Auto-recover: if pool entry is missing but we know the dbPath, re-initialize
  if (!entry) {
    const dbPath = knownDbPaths.get(repoId);
    if (dbPath) {
      dbLogger.info({ repoId, dbPath }, 'Auto-recovering missing pool entry');
      await initLbug(repoId, dbPath);
      entry = pool.get(repoId);
    }
    if (!entry) {
      throw new Error(`LadybugDB not initialized for repo "${repoId}". Call initLbug first.`);
    }
  }

  // Check for rebuild lock before querying
  if (await checkRebuildLock(repoId, entry.dbPath)) {
    throw new Error('Database is being rebuilt. Retry the operation.');
  }

  // Pre-flight: verify DB file still exists and hasn't been replaced (prevents native crash)
  if (!(await preflightCheck(repoId, entry))) {
    // Pool was closed — retry with auto-recovery
    return executeParameterized(repoId, cypher, params);
  }

  entry.lastUsed = Date.now();

  // Log query attempt for crash diagnostics
  dbLogger.debug({ repoId, query: cypher.slice(0, 100) }, 'Executing parameterized query');

  const conn = await checkout(entry);
  let result: any = null;
  try {
    const stmt: any = await withTimeout(conn.prepare(cypher), QUERY_TIMEOUT_MS, 'Prepare');
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      throw new Error(`Prepare failed: ${errMsg}`);
    }
    const queryResult = await withTimeout(conn.execute(stmt, params), QUERY_TIMEOUT_MS, 'Execute');
    result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    const rows = await result.getAll();
    // Explicitly close result to prevent GC destructor hang (LadybugDB bug)
    try { result.close(); } catch {}
    result = null;
    return rows;
  } catch (err: any) {
    const error = err instanceof Error ? err : new Error(String(err));
    dbLogger.warn({ err: error, repoId }, 'Parameterized query failed');
    if (await recoverFromDbError(repoId, error)) {
      return executeParameterized(repoId, cypher, params);
    }
    throw error;
  } finally {
    // Always close result to prevent GC destructor hang
    if (result) { try { result.close(); } catch {} }
    checkin(entry, conn);
  }
};

/**
 * Close one or all repo pools.
 * If repoId is provided, close only that repo's connections.
 * If omitted, close all repos.
 */
export const closeLbug = async (repoId?: string): Promise<void> => {
  if (repoId) {
    await closeOne(repoId);
    return;
  }

  for (const id of [...pool.keys()]) {
    await closeOne(id);
  }

  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }

  stopRebuildWatcher();
};


/**
 * Check if a specific repo's pool is active
 */
export const isLbugReady = (repoId: string): boolean => pool.has(repoId);
