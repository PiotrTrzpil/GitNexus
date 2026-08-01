/**
 * Cross-process Lockfile Utilities
 *
 * Provides atomic locking with stale lock detection.
 * Uses PID-based lockfiles with timestamps for stale detection.
 *
 * Stale takeover is atomic (unlink + O_EXCL create) so two waiters cannot
 * both "win" a dead lock and both believe they hold it.
 */

import fs from 'fs/promises';

export interface LockOptions {
  /** Stale timeout in ms (default: 5 minutes). Used when stealFromLive is true. */
  staleMs?: number;
  /** Poll interval when waiting for lock (default: 500ms) */
  pollIntervalMs?: number;
  /** Max wait time in ms (default: 30 seconds) */
  maxWaitMs?: number;
  /**
   * When true (default), a lock held by a *live* process older than staleMs
   * may be stolen. Set false for long-lived leaders (e.g. watcher leader)
   * that only refresh timestamps via refreshLock — steal only if the PID is dead.
   */
  stealFromLive?: boolean;
}

const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_WAIT_MS = 30 * 1000;

/**
 * Check if a process with the given PID is alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

function lockPayload(): string {
  return JSON.stringify({ pid: process.pid, ts: Date.now() });
}

/**
 * Exclusive-create a lock file. Returns true on success.
 */
async function exclusiveCreate(lockPath: string): Promise<boolean> {
  try {
    const fd = await fs.open(lockPath, 'wx');
    try {
      await fd.writeFile(lockPayload());
    } finally {
      await fd.close();
    }
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    return false;
  }
}

/**
 * Try to acquire a lock. Returns true if lock acquired, false if held by another process.
 * Automatically removes stale locks (dead process, or timed-out live holder when
 * stealFromLive is true).
 */
export async function tryAcquireLock(
  lockPath: string,
  options: LockOptions = {}
): Promise<boolean> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const stealFromLive = options.stealFromLive !== false;

  if (await exclusiveCreate(lockPath)) return true;

  // Lock exists — check if we may reclaim it
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const { pid, ts } = JSON.parse(content);
    const age = Date.now() - (typeof ts === 'number' ? ts : 0);
    const alive = typeof pid === 'number' && isProcessAlive(pid);

    const reclaim =
      !alive || // dead holder
      (stealFromLive && age > staleMs); // hung live holder (reindex, analyze)

    if (!reclaim) return false;

    // Atomic reclaim: only one waiter wins the exclusive re-create.
    try {
      await fs.unlink(lockPath);
    } catch {
      // Already gone — fall through to exclusive create
    }
    return exclusiveCreate(lockPath);
  } catch {
    // Unreadable/corrupt lock — try reclaim once
    try {
      await fs.unlink(lockPath);
    } catch {
      /* ignore */
    }
    return exclusiveCreate(lockPath);
  }
}

/**
 * Refresh the timestamp on a lock we own (leader heartbeat).
 * Returns false if the lock is missing or owned by another PID.
 */
export async function refreshLock(lockPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const { pid } = JSON.parse(content);
    if (pid !== process.pid) return false;
    await fs.writeFile(lockPath, lockPayload());
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for a lock to be released (blocking).
 * Returns true when lock is released, false if timeout exceeded.
 */
export async function waitForLockRelease(
  lockPath: string,
  options: LockOptions = {}
): Promise<boolean> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const stealFromLive = options.stealFromLive !== false;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(lockPath, 'utf-8');
      const { pid, ts } = JSON.parse(content);
      const age = Date.now() - (typeof ts === 'number' ? ts : 0);
      const alive = typeof pid === 'number' && isProcessAlive(pid);

      if (!alive || (stealFromLive && age > staleMs)) {
        try {
          await fs.unlink(lockPath);
        } catch {
          /* ignore */
        }
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    } catch {
      // Lock file doesn't exist or can't be read — consider released
      return true;
    }
  }

  return false; // Timeout exceeded
}

/**
 * Release a lock we own. No-ops if the lock is missing or held by another PID
 * (so a demoted leader cannot wipe a newer leader's lock).
 */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const { pid } = JSON.parse(content);
    if (pid !== process.pid) return;
  } catch {
    // Missing/unreadable — still try unlink below (best-effort for our empty files)
  }
  try {
    await fs.unlink(lockPath);
  } catch {
    // Best effort — lock may not exist or already released
  }
}

/**
 * Check if a lock exists and is held by an active process.
 */
export async function isLocked(
  lockPath: string,
  options: LockOptions = {}
): Promise<boolean> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const stealFromLive = options.stealFromLive !== false;

  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const { pid, ts } = JSON.parse(content);
    const age = Date.now() - (typeof ts === 'number' ? ts : 0);
    const alive = typeof pid === 'number' && isProcessAlive(pid);

    if (!alive || (stealFromLive && age > staleMs)) {
      try {
        await fs.unlink(lockPath);
      } catch {
        /* ignore */
      }
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Get info about a lock (for debugging/logging).
 */
export async function getLockInfo(
  lockPath: string
): Promise<{ pid: number; ts: number; age: number; alive: boolean } | null> {
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const { pid, ts } = JSON.parse(content);
    return {
      pid,
      ts,
      age: Date.now() - (typeof ts === 'number' ? ts : 0),
      alive: typeof pid === 'number' && isProcessAlive(pid),
    };
  } catch {
    return null;
  }
}
