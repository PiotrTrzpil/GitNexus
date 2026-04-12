/**
 * File Watcher — Adaptive Polling
 *
 * Polls repository file trees at an adaptive interval that scales with
 * the number of files. When changes are detected (via mtime+size snapshot),
 * calls onReindex to trigger incremental re-analysis.
 *
 * Runs inside the MCP server process — not a separate daemon.
 * Uses setInterval rather than fs.watch for cross-platform reliability.
 *
 * Port from: codebase-memory-mcp/internal/watcher/watcher.go
 */

import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { createIgnoreFilter } from '../../config/ignore-service.js';
import { tryAcquireLock, releaseLock } from '../../util/lockfile.js';

export interface WatcherOptions {
  onReindex: (repoPath: string) => Promise<void>;
  gracePeriodMs?: number;    // default 5000
  maxIntervalMs?: number;    // default 60000
}

interface RepoConfig {
  path: string;
  fileCount: number;
}

interface FileSnapshot {
  mtime: number;
  size: number;
}

interface RepoState {
  snapshot: Map<string, FileSnapshot> | null;
  reindexing: boolean;
  nextPollAt: number;
}

/**
 * Compute the adaptive polling interval from file count.
 * Formula: 1000ms base + 1000ms per 500 files, capped at maxIntervalMs.
 * Mirrors pollInterval() in watcher.go exactly.
 */
function computeInterval(fileCount: number, maxIntervalMs: number): number {
  const ms = 1000 + Math.floor(fileCount / 500) * 1000;
  return Math.min(ms, maxIntervalMs);
}

/**
 * Walk the repo and capture {mtime, size} for each file.
 * Uses the same ignore filter as the ingestion pipeline, with directory-level
 * pruning so node_modules/dist/etc are never traversed.
 */
async function captureSnapshot(repoPath: string): Promise<Map<string, FileSnapshot>> {
  const ignoreFilter = await createIgnoreFilter(repoPath);

  const files = await glob('**/*', {
    cwd: repoPath,
    nodir: true,
    dot: false,
    ignore: ignoreFilter,
  });

  const snap = new Map<string, FileSnapshot>();

  const CONCURRENCY = 64;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async relPath => {
        try {
          const stat = await fs.stat(path.join(repoPath, relPath));
          snap.set(relPath, { mtime: stat.mtimeMs, size: stat.size });
        } catch (err: any) {
          if (err?.code !== 'ENOENT') {
            console.warn(`[watcher] stat failed for ${relPath}: ${err?.code ?? err?.message}`);
          }
        }
      })
    );
  }

  return snap;
}

/**
 * Compare two snapshots for equality.
 * Returns false as soon as any difference is found.
 */
function snapshotsEqual(
  prev: Map<string, FileSnapshot>,
  curr: Map<string, FileSnapshot>
): boolean {
  if (prev.size !== curr.size) return false;
  for (const [relPath, prevEntry] of prev) {
    const currEntry = curr.get(relPath);
    if (!currEntry) return false;
    if (prevEntry.mtime !== currEntry.mtime || prevEntry.size !== currEntry.size) return false;
  }
  return true;
}

// ─── Cross-process lockfile ──────────────────────────────────────────────
// Prevents multiple MCP instances from reindexing the same repo concurrently.
// Uses shared lockfile utility with PID-based stale detection.

function reindexLockPath(repoPath: string): string {
  return path.join(repoPath, '.gitnexus', 'reindex.lock');
}

async function tryAcquireReindexLock(repoPath: string): Promise<boolean> {
  return tryAcquireLock(reindexLockPath(repoPath));
}

async function releaseReindexLock(repoPath: string): Promise<void> {
  return releaseLock(reindexLockPath(repoPath));
}

/**
 * Poll a single repo: capture snapshot, compare with baseline,
 * trigger reindex if changed.
 *
 * First call after grace period establishes the baseline snapshot —
 * no reindex is fired on the first poll.
 */
async function pollRepo(
  repo: RepoConfig,
  state: RepoState,
  options: WatcherOptions
): Promise<void> {
  const maxIntervalMs = options.maxIntervalMs ?? 60000;

  // Verify the root path still exists
  try {
    await fs.stat(repo.path);
  } catch {
    console.warn(`[watcher] repo path gone: ${repo.path}`);
    state.nextPollAt = Date.now() + maxIntervalMs;
    return;
  }

  let snap: Map<string, FileSnapshot>;
  try {
    snap = await captureSnapshot(repo.path);
  } catch (err) {
    console.warn(`[watcher] snapshot failed for ${repo.path}:`, err);
    const interval = computeInterval(repo.fileCount, maxIntervalMs);
    state.nextPollAt = Date.now() + interval;
    return;
  }

  const fileCount = snap.size;
  const interval = computeInterval(fileCount, maxIntervalMs);

  if (state.snapshot === null) {
    // First poll — establish baseline, do not trigger reindex
    state.snapshot = snap;
    state.nextPollAt = Date.now() + interval;
    return;
  }

  if (snapshotsEqual(state.snapshot, snap)) {
    state.nextPollAt = Date.now() + interval;
    return;
  }

  // Changes detected — skip if a reindex is already in flight (TryLock pattern)
  if (state.reindexing) {
    state.nextPollAt = Date.now() + interval;
    return;
  }

  // Cross-process lock — another MCP instance may already be reindexing
  if (!(await tryAcquireReindexLock(repo.path))) {
    // Another process holds the lock — skip this cycle, update snapshot
    // so we don't re-trigger on the same diff next cycle
    state.snapshot = snap;
    state.nextPollAt = Date.now() + interval;
    return;
  }

  state.reindexing = true;
  try {
    await options.onReindex(repo.path);
    // Successful reindex — update snapshot and recalculate interval
    state.snapshot = snap;
    state.nextPollAt = Date.now() + computeInterval(snap.size, maxIntervalMs);
  } catch (err) {
    console.warn(`[watcher] reindex failed for ${repo.path}:`, err);
    // Keep old snapshot so we retry next cycle
    state.nextPollAt = Date.now() + interval;
  } finally {
    await releaseReindexLock(repo.path);
    state.reindexing = false;
  }
}

/**
 * Start the adaptive file watcher for one or more repositories.
 *
 * @param repos  List of repos to watch, each with a path and initial file count
 *               (used only for the first interval calculation before a snapshot exists).
 * @param options  onReindex callback, gracePeriodMs, maxIntervalMs
 * @returns  stopWatcher function — call it to halt polling
 */
export function startWatcher(
  repos: RepoConfig[],
  options: WatcherOptions
): () => void {
  const gracePeriodMs = options.gracePeriodMs ?? 5000;
  const maxIntervalMs = options.maxIntervalMs ?? 60000;

  // One state entry per repo, keyed by repo path
  const states = new Map<string, RepoState>();
  for (const repo of repos) {
    states.set(repo.path, {
      snapshot: null,
      reindexing: false,
      nextPollAt: 0,  // will be set after grace period
    });
  }

  let stopped = false;
  let timerId: ReturnType<typeof setInterval> | null = null;

  // Tick handler — runs every 1 second, fires polls only when due
  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    for (const repo of repos) {
      const state = states.get(repo.path)!;
      if (now < state.nextPollAt) continue;
      // Advance nextPollAt immediately to prevent overlapping polls
      // (the real value is set at end of pollRepo, but this guards concurrent ticks)
      state.nextPollAt = now + computeInterval(repo.fileCount, maxIntervalMs);
      pollRepo(repo, state, options).catch(err => {
        console.warn(`[watcher] unexpected error polling ${repo.path}:`, err);
      });
    }
  };

  // Grace period before first poll
  const gracTimer = setTimeout(() => {
    if (stopped) return;
    timerId = setInterval(tick, 1000);
  }, gracePeriodMs);

  return () => {
    stopped = true;
    clearTimeout(gracTimer);
    if (timerId !== null) clearInterval(timerId);
  };
}
