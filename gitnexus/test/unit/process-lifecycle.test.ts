/**
 * Process-lifecycle hard-kill helpers, exercised in real child processes:
 * the behaviour under test (a SIGKILL that fires while the main thread is
 * blocked) cannot be observed with mocks.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODULE_URL = pathToFileURL(
  path.resolve(__dirname, '../../src/utils/process-lifecycle.ts'),
).href;

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  elapsedMs: number;
}

/** Run `body` (async JS) in a child with the lifecycle module bound as `lc`. */
function runChild(body: string, timeoutMs = 15_000): Promise<ChildResult> {
  const script = `import(${JSON.stringify(MODULE_URL)}).then(async (lc) => { ${body} });`;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: path.resolve(__dirname, '../..'),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child still alive after ${timeoutMs}ms; stderr: ${stderr}`));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stderr, elapsedMs: Date.now() - start });
    });
  });
}

describe('process-lifecycle', () => {
  it('armSigkillWatchdog SIGKILLs a process whose main thread is blocked', async () => {
    // Busy-loop for far longer than the 500 ms grace. A main-thread timer
    // could never fire here; only the worker thread can.
    const result = await runChild(`
      lc.armSigkillWatchdog(500);
      const end = Date.now() + 10000;
      while (Date.now() < end) {}
      process.exit(0);
    `);
    expect(result.signal).toBe('SIGKILL');
    expect(result.elapsedMs).toBeLessThan(8_000);
  });

  it('armSigkillWatchdog does not fire once disarmed', async () => {
    const result = await runChild(`
      const disarm = lc.armSigkillWatchdog(300);
      disarm();
      setTimeout(() => process.exit(7), 1200);
    `);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(7);
  });

  it('armSigkillWatchdog does not keep a finished process alive', async () => {
    const result = await runChild(`lc.armSigkillWatchdog(60000);`, 10_000);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
  });

});
