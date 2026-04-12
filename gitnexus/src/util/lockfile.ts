/**
 * Cross-process Lockfile Utilities
 *
 * Provides atomic locking with stale lock detection.
 * Uses PID-based lockfiles with timestamps for stale detection.
 */

import fs from 'fs/promises';

export interface LockOptions {
  /** Stale timeout in ms (default: 5 minutes) */
  staleMs?: number;
  /** Poll interval when waiting for lock (default: 500ms) */
  pollIntervalMs?: number;
  /** Max wait time in ms (default: 30 seconds) */
  maxWaitMs?: number;
}

const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_WAIT_MS = 30 * 1000;

/**
 * Check if a process with the given PID is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to acquire a lock. Returns true if lock acquired, false if held by another process.
 * Automatically removes stale locks (process dead or timeout exceeded).
 */
export async function tryAcquireLock(
  lockPath: string,
  options: LockOptions = {}
): Promise<boolean> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  try {
    // Atomic create — O_WRONLY | O_CREAT | O_EXCL
    const fd = await fs.open(lockPath, 'wx');
    await fd.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
    await fd.close();
    return true;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') return false;

    // Lock exists — check if stale
    try {
      const content = await fs.readFile(lockPath, 'utf-8');
      const { pid, ts } = JSON.parse(content);
      const age = Date.now() - ts;

      if (age > staleMs || !isProcessAlive(pid)) {
        // Stale lock — take it over
        await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        return true;
      }

      return false; // Lock held by active process
    } catch {
      return false; // Can't read/parse lock — leave it alone
    }
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
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(lockPath, 'utf-8');
      const { pid, ts } = JSON.parse(content);
      const age = Date.now() - ts;

      // Lock is stale — remove it and return
      if (age > staleMs || !isProcessAlive(pid)) {
        try { await fs.unlink(lockPath); } catch {}
        return true;
      }

      // Lock is held — wait
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    } catch {
      // Lock file doesn't exist or can't be read — consider released
      return true;
    }
  }

  return false; // Timeout exceeded
}

/**
 * Release a lock. Safe to call even if lock doesn't exist.
 */
export async function releaseLock(lockPath: string): Promise<void> {
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

  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const { pid, ts } = JSON.parse(content);
    const age = Date.now() - ts;

    if (age > staleMs || !isProcessAlive(pid)) {
      // Stale lock — remove it
      try { await fs.unlink(lockPath); } catch {}
      return false;
    }

    return true; // Lock held by active process
  } catch {
    return false; // Lock doesn't exist
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
      age: Date.now() - ts,
      alive: isProcessAlive(pid),
    };
  } catch {
    return null;
  }
}
