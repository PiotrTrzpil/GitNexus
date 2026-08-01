/**
 * Process lifecycle helpers for MCP and long-lived CLI processes.
 *
 * Background: LadybugDB / libuv work can block `process.exit()` forever
 * (uv_thread_join on a stuck DatabaseInit worker). After SIGSEGV the process
 * is also undefined — calling process.exit() can spin at 100% CPU for days
 * as an orphan under launchd.
 *
 * Always arm a SIGKILL watchdog *before* any soft exit. For fatal hardware
 * signals, skip soft exit and SIGKILL immediately.
 */

import { Worker } from 'worker_threads';
import { spawn } from 'child_process';

/** Default grace period before SIGKILL during soft shutdown. */
export const DEFAULT_FORCE_EXIT_MS = 3000;

/**
 * Signals that leave the process in an undefined state. Soft exit is unsafe;
 * the only reliable recovery is kernel-enforced SIGKILL.
 */
export const FATAL_SIGNALS = [
  'SIGSEGV',
  'SIGBUS',
  'SIGILL',
  'SIGFPE',
  'SIGABRT',
] as const;

export type FatalSignal = (typeof FATAL_SIGNALS)[number];

/**
 * Arm an independent SIGKILL after `ms`.
 *
 * Uses a Worker thread so the kill still fires when the main thread is
 * wedged inside native code (libuv timers would not run). Falls back to a
 * detached shell sleep+kill if Worker construction fails.
 */
export function armSigkillWatchdog(ms: number = DEFAULT_FORCE_EXIT_MS): void {
  const pid = process.pid;
  try {
    const src = `setTimeout(() => { try { process.kill(${pid}, 'SIGKILL'); } catch {} }, ${ms});`;
    const w = new Worker(src, { eval: true });
    w.unref();
  } catch {
    try {
      const child = spawn(
        'sh',
        ['-c', `sleep ${Math.max(1, Math.ceil(ms / 1000))}; kill -9 ${pid}`],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
    } catch {
      // Nothing else we can do — caller may still attempt process.exit.
    }
  }
}

/**
 * Soft exit with a hard deadline. Prefer this over bare `process.exit()`.
 * Does not return (typed as `never`).
 */
export function exitWithWatchdog(
  code: number,
  ms: number = DEFAULT_FORCE_EXIT_MS,
): never {
  armSigkillWatchdog(ms);
  process.exit(code);
  // process.exit is typed as `never` but keep a throw for analysis tools.
  throw new Error('process.exit did not terminate');
}

/**
 * Immediate hard kill. Use after fatal signals (SIGSEGV, …) where the
 * heap/native state may be corrupted and process.exit can hang forever.
 */
export function hardKillSelf(): never {
  try {
    process.kill(process.pid, 'SIGKILL');
  } catch {
    // fall through to watchdog + exit
  }
  // If kill() failed to deliver (should not happen for self-SIGKILL on Unix),
  // arm a short watchdog and attempt soft exit as last resort.
  armSigkillWatchdog(100);
  process.exit(1);
  throw new Error('hardKillSelf did not terminate');
}

/**
 * Best-effort crash log to stderr (async-signal-unsafe but acceptable for
 * diagnostics). Never throws.
 */
export function writeCrashLine(message: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('fs').writeSync(2, message.endsWith('\n') ? message : `${message}\n`);
  } catch {
    // ignore
  }
}

/**
 * Install handlers for fatal signals that log (optional) then SIGKILL.
 * Idempotent per signal via process listener replacement is caller's concern;
 * safe to call once at MCP startup.
 */
export function installFatalSignalHandlers(
  onFatal?: (sig: FatalSignal) => void,
): void {
  for (const sig of FATAL_SIGNALS) {
    process.on(sig, () => {
      writeCrashLine(`\n[MCP CRASH] Received ${sig}\n`);
      try {
        onFatal?.(sig);
      } catch {
        // Logger may be broken after a segfault — ignore.
      }
      hardKillSelf();
    });
  }
}
