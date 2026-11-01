/**
 * Process-lifecycle hard-kill helpers for long-lived MCP processes.
 *
 * Stock LadybugDB has a recursive `QueryResult::~QueryResult()` that can wedge
 * the Node main thread inside a synchronous C++ destructor. While that
 * happens no JS timer on the main thread can fire, so a
 * `setTimeout(process.exit, ...)` safety net is useless and the process
 * can spin at 100% CPU forever as an orphan. `armSigkillWatchdog` runs the
 * deadline on a worker thread with its own event loop, which keeps ticking
 * while the main thread is blocked.
 *
 * Deliberately NO listeners for SIGSEGV/SIGBUS/SIGILL/SIGFPE: for a genuine
 * fault, a JS listener replaces the kernel's default termination, the
 * handler returns, the faulting instruction re-executes, and the process can
 * loop forever (Node docs: "might cause the process to stop responding").
 * The default action — terminate — is the behaviour we want.
 */

import { Worker } from 'node:worker_threads';

/**
 * Grace period between the start of shutdown and the SIGKILL. Longer than the
 * main-thread `process.exit` timer in `mcp/server.ts` so a shutdown that is
 * merely slow still exits on its own terms first.
 */
export const DEFAULT_WATCHDOG_MS = 8_000;


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

