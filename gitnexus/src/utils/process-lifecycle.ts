/**
 * Process-lifecycle hard-kill helpers for long-lived MCP processes.
 *
 * Stock LadybugDB has a recursive `QueryResult::~QueryResult()` that can wedge
 * the Node main thread inside a synchronous C++ destructor. While that
 * happens no JS timer on the main thread can fire, so a
 * `setTimeout(process.exit, ...)` safety net is useless and the process
 * can spin at 100% CPU forever as an orphan. Two helpers cover this:
 *
 * - `armSigkillWatchdog` runs the deadline on a worker thread with its own
 *   event loop, which keeps ticking while the main thread is blocked.
 * - `installFatalSignalHandlers` makes a crash signal end the process
 *   immediately instead of leaving it in an undefined state.
 */

import { Worker } from 'node:worker_threads';
import { writeSync } from 'node:fs';

/**
 * Grace period between the start of shutdown and the SIGKILL. Longer than the
 * main-thread `process.exit` timer in `mcp/server.ts` so a shutdown that is
 * merely slow still exits on its own terms first.
 */
export const DEFAULT_WATCHDOG_MS = 8_000;

/** Signals after which the process state is undefined; cleanup is unsafe. */
export const FATAL_SIGNALS = ['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGABRT'] as const;

export type FatalSignal = (typeof FATAL_SIGNALS)[number];

// The worker's own timer is what fires; the main thread only supplies pid/ms.
const WATCHDOG_WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
setTimeout(() => {
  try { process.kill(workerData.pid, 'SIGKILL'); } catch {}
}, workerData.ms);
`;

/**
 * Send SIGKILL to this process after `ms` unless the returned `disarm` is
 * called first. The worker is unref'd so it never keeps the process alive.
 * If the worker cannot be created the watchdog is simply absent (the
 * main-thread timer in the caller remains); this never throws.
 */
export function armSigkillWatchdog(ms: number = DEFAULT_WATCHDOG_MS): () => void {
  try {
    const worker = new Worker(WATCHDOG_WORKER_SOURCE, {
      eval: true,
      workerData: { pid: process.pid, ms },
    });
    worker.unref();
    // A worker error (e.g. resource limits) must not crash the main thread.
    worker.on('error', () => {});
    return () => {
      void worker.terminate().catch(() => {});
    };
  } catch {
    return () => {};
  }
}

/**
 * On a fatal signal, write one line to stderr and SIGKILL ourselves. Never
 * calls `process.exit` and never runs async cleanup: both can hang or touch
 * corrupted state.
 *
 * Best effort only: a real SIGSEGV/SIGBUS raised by faulting native code is
 * delivered to the faulting thread, and Node only runs a JS listener if that
 * is the main thread and the V8 state is still sound. These handlers reliably
 * catch signals sent from outside (`kill -SEGV`, `abort()` raising SIGABRT
 * on a path Node reports), but may never run for a genuine memory fault, in
 * which case the kernel default (core dump / termination) applies.
 */
export function installFatalSignalHandlers(): void {
  for (const signal of FATAL_SIGNALS) {
    process.on(signal, () => {
      try {
        writeSync(2, `GitNexus MCP fatal signal ${signal}; killing process\n`);
      } catch {
        // stderr may be closed; the kill below is what matters.
      }
      process.kill(process.pid, 'SIGKILL');
    });
  }
}
