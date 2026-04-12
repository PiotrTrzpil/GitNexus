/**
 * Client for ts-morph rename worker.
 *
 * Spawns a worker thread for ts-morph operations and enforces a hard timeout
 * via worker.terminate(). This is the only way to interrupt synchronous
 * TypeScript compiler operations that block the event loop.
 */

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renameLogger } from '../../util/logger.js';

/** Default timeout for rename operations (60 seconds) */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface TsMorphEdit {
  filePath: string;
  line: number;
  old_text: string;
  new_text: string;
  confidence: 'ts_morph';
}

export interface TsMorphSuccess {
  status: 'success';
  edits: TsMorphEdit[];
}

export interface TsMorphNotFound {
  status: 'not_found';
  reason: string;
  details?: {
    file?: string;
    line?: number;
    column?: number;
    actualLineContent?: string;
    searchedFor?: string;
  };
}

export type TsMorphResult = TsMorphSuccess | TsMorphNotFound;

/**
 * Get the path to the worker script.
 * Handles both development (src/) and production (dist/) paths.
 */
function getWorkerPath(): string {
  const dirname = path.dirname(fileURLToPath(import.meta.url));

  // Try dist path first (production)
  const distPath = path.join(dirname, 'workers', 'ts-morph-worker.js');
  if (fs.existsSync(distPath)) {
    return distPath;
  }

  // Fall back to src path (development with ts-node or similar)
  const srcPath = path.join(dirname, 'workers', 'ts-morph-worker.ts');
  if (fs.existsSync(srcPath)) {
    return srcPath;
  }

  throw new Error(`Worker script not found at ${distPath} or ${srcPath}`);
}

/**
 * Execute a ts-morph rename operation in a worker thread with a hard timeout.
 *
 * Unlike Promise.race with setTimeout, this actually terminates the worker
 * if it exceeds the timeout, freeing up CPU resources.
 */
export async function tsMorphRenameInWorker(opts: {
  repoPath: string;
  filePath: string;
  line: number;
  column?: number;
  oldName: string;
  newName: string;
  dryRun: boolean;
  timeoutMs?: number;
}): Promise<TsMorphResult> {
  const { repoPath, filePath, line, column, oldName, newName, dryRun, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  const workerPath = getWorkerPath();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const worker = new Worker(workerPath);

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      worker.removeAllListeners();
    };

    const settle = (result: TsMorphResult | Error) => {
      if (settled) return;
      settled = true;
      cleanup();

      // Always terminate the worker to free resources
      worker.terminate().catch(() => {});

      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    // Set hard timeout - will terminate the worker
    timer = setTimeout(() => {
      renameLogger.warn({ oldName, newName, filePath, timeoutMs }, 'ts-morph worker timed out, terminating');
      settle(new Error(`ts-morph rename timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.on('message', (msg: any) => {
      if (msg.type === 'success') {
        settle({ status: 'success', edits: msg.edits });
      } else if (msg.type === 'not_found') {
        settle({
          status: 'not_found',
          reason: msg.reason,
          details: msg.details,
        });
      } else if (msg.type === 'error') {
        settle(new Error(msg.message));
      } else {
        settle(new Error(`Unknown worker message: ${JSON.stringify(msg).slice(0, 200)}`));
      }
    });

    worker.on('error', (err) => {
      renameLogger.error({ err, oldName, filePath }, 'ts-morph worker error');
      settle(err);
    });

    worker.on('exit', (code) => {
      if (!settled) {
        settle(new Error(`Worker exited with code ${code}`));
      }
    });

    // Send the rename request to the worker
    worker.postMessage({
      type: 'rename',
      repoPath,
      filePath,
      line,
      column,
      oldName,
      newName,
      dryRun,
    });
  });
}
