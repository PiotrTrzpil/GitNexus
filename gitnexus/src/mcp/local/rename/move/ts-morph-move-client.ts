/**
 * Runs the ts-morph move planner in a worker thread with a hard timeout:
 * on expiry the thread is terminated, which is the only way to interrupt the
 * synchronous TypeScript compiler. The worker never writes, so termination is safe.
 */

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MoveRequest, MoveResponse, MoveSuccess } from './protocol.js';

export const DEFAULT_MOVE_TIMEOUT_MS = 60_000;

const _require = createRequire(import.meta.url);

function workerPath(): { file: string; execArgv: string[] } {
  const callerPath = fileURLToPath(import.meta.url);
  const isDev = callerPath.endsWith('.ts');
  return {
    file: path.join(
      path.dirname(callerPath),
      isDev ? 'ts-morph-move-worker.ts' : 'ts-morph-move-worker.js',
    ),
    // Source runs (vitest/tsx) need the tsx loader inside the worker thread too.
    execArgv: isDev ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href] : [],
  };
}

export function planMoveInWorker(
  request: Omit<MoveRequest, 'type'>,
  timeoutMs: number = DEFAULT_MOVE_TIMEOUT_MS,
): Promise<MoveSuccess> {
  const { file, execArgv } = workerPath();
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(file, { execArgv });
    const settle = (outcome: MoveSuccess | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(
      () => settle(new Error(`ts-morph move planning timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    worker.on('message', (msg: MoveResponse) =>
      settle(msg.type === 'success' ? msg : new Error(msg.message)),
    );
    worker.on('error', (err: Error) => settle(err));
    worker.on('exit', (code) => settle(new Error(`ts-morph move worker exited with code ${code}`)));
    worker.postMessage({ type: 'plan-move', ...request } satisfies MoveRequest);
  });
}
