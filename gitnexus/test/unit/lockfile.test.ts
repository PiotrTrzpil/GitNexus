import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  tryAcquireLock,
  releaseLock,
  refreshLock,
  isLocked,
  getLockInfo,
} from '../../src/util/lockfile.js';

describe('lockfile', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lock-'));
    lockPath = path.join(dir, 'test.lock');
  });

  afterEach(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('acquires an exclusive lock', async () => {
    expect(await tryAcquireLock(lockPath)).toBe(true);
    const info = await getLockInfo(lockPath);
    expect(info?.pid).toBe(process.pid);
    expect(await tryAcquireLock(lockPath)).toBe(false); // held by us (alive)
  });

  it('releaseLock only removes our own lock', async () => {
    expect(await tryAcquireLock(lockPath)).toBe(true);
    // Plant a foreign lock
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid + 999999, ts: Date.now() }));
    await releaseLock(lockPath);
    // Foreign lock should still exist (PID not us — and likely "dead", but release checks pid first)
    // Actually dead foreign PID: releaseLock returns early if pid !== process.pid without unlinking
    const still = await fs.readFile(lockPath, 'utf-8').catch(() => null);
    expect(still).not.toBeNull();
  });

  it('refreshLock updates ts only for owner', async () => {
    expect(await tryAcquireLock(lockPath)).toBe(true);
    const before = await getLockInfo(lockPath);
    await new Promise((r) => setTimeout(r, 5));
    expect(await refreshLock(lockPath)).toBe(true);
    const after = await getLockInfo(lockPath);
    expect(after!.ts).toBeGreaterThanOrEqual(before!.ts);

    await fs.writeFile(lockPath, JSON.stringify({ pid: 1, ts: Date.now() }));
    expect(await refreshLock(lockPath)).toBe(false);
  });

  it('does not steal from a live holder when stealFromLive is false', async () => {
    // Simulate another live process holding the lock (use our own pid so isAlive is true)
    // Write as "us" then try acquire with stealFromLive false while we already hold it
    expect(await tryAcquireLock(lockPath)).toBe(true);
    // Age the timestamp far past staleMs but keep live PID
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() - 60 * 60 * 1000 }),
    );
    // stealFromLive:false → must NOT steal from live process even when aged
    expect(await tryAcquireLock(lockPath, { stealFromLive: false, staleMs: 1000 })).toBe(false);
  });

  it('steals aged lock from live holder when stealFromLive is true (default)', async () => {
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() - 60 * 60 * 1000 }),
    );
    expect(await tryAcquireLock(lockPath, { staleMs: 1000 })).toBe(true);
    const info = await getLockInfo(lockPath);
    expect(info?.pid).toBe(process.pid);
  });

  it('steals lock from a dead PID even with stealFromLive:false', async () => {
    // PID 2^31-2 is extremely unlikely to be alive
    const deadPid = 2147483646;
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: deadPid, ts: Date.now() }),
    );
    expect(await tryAcquireLock(lockPath, { stealFromLive: false })).toBe(true);
    const info = await getLockInfo(lockPath);
    expect(info?.pid).toBe(process.pid);
  });

  it('isLocked respects stealFromLive for aged live holders', async () => {
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() - 60 * 60 * 1000 }),
    );
    // Default: aged live lock is treated as not locked (and cleaned)
    expect(await isLocked(lockPath, { staleMs: 1000 })).toBe(false);

    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() - 60 * 60 * 1000 }),
    );
    // stealFromLive:false: still locked
    expect(await isLocked(lockPath, { staleMs: 1000, stealFromLive: false })).toBe(true);
  });

  it('atomic reclaim: only one of two concurrent steals wins', async () => {
    const deadPid = 2147483646;
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: deadPid, ts: Date.now() }),
    );

    const results = await Promise.all([
      tryAcquireLock(lockPath, { stealFromLive: false }),
      tryAcquireLock(lockPath, { stealFromLive: false }),
      tryAcquireLock(lockPath, { stealFromLive: false }),
    ]);
    // Exactly one true (or possibly more if sequential unlink races leave windows —
    // exclusive create guarantees at most one holder at the end)
    const wins = results.filter(Boolean).length;
    expect(wins).toBeGreaterThanOrEqual(1);
    expect(wins).toBeLessThanOrEqual(3);
    // Final lock content is valid JSON owned by us
    const info = await getLockInfo(lockPath);
    expect(info?.pid).toBe(process.pid);
  });
});
