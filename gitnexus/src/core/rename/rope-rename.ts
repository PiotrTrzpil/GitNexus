/**
 * Rope-powered refactorings for Python.
 * Delegates to Python scripts that use the `rope` refactoring library
 * for scope-aware, semantically correct symbol renames and module moves.
 *
 * Error contract (mirrors ts-morph-rename):
 * - Returns `null` when the symbol cannot be located (clean signal to fall back).
 * - Throws on infrastructure errors (rope not installed, IO, syntax errors).
 */

import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { renameLogger } from '../../util/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Run a Python script with JSON on stdin and capture stdout/stderr.
 * On timeout the child is SIGTERM'd then SIGKILL'd so it cannot keep writing
 * after the caller has given up (critical for apply-mode safety).
 */
function runPythonScript(
  python: string,
  scriptPath: string,
  input: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let escalateTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      fn();
    };

    killTimer = setTimeout(() => {
      timedOut = true;
      renameLogger.error({ scriptPath, timeout }, 'Python rope script timed out — killing child');
      try {
        proc.kill('SIGTERM');
      } catch { /* already dead */ }
      escalateTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch { /* already dead */ }
      }, 2000);
      // Reject/resolve only on 'close' so we don't race the process exit
    }, timeout);

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      settle(() => reject(err));
    });
    proc.on('close', (code) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(
            `rope script timed out after ${timeout}ms and was killed` +
            (stdout ? ` (partial stdout: ${stdout.slice(0, 200)})` : ''),
          ));
          return;
        }
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/** Timeout for Python module/package moves (rope scans the whole project). */
const ROPE_MOVE_TIMEOUT_MS = 180_000;

const PY_EXTENSIONS = new Set(['.py', '.pyw', '.pyi']);

export function isPythonFile(filePath: string): boolean {
  return PY_EXTENSIONS.has(path.extname(filePath));
}

export interface RopeEdit {
  filePath: string;
  line: number;
  old_text: string;
  new_text: string;
  confidence: 'rope';
}

export interface RopeMoveResult {
  edits: RopeEdit[];
  files_moved: { from: string; to: string }[];
}

/** Resolve a script under package scripts/ relative to this module. */
function getScriptPath(scriptName: string): string {
  // In dist: dist/core/rename/rope-rename.js → ../../scripts/<script> (relative to package root)
  return path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', scriptName);
}

/** Find a working Python 3 interpreter. */
async function findPython(): Promise<string> {
  for (const candidate of ['python3', 'python']) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 5000 });
      if (stdout.includes('Python 3')) return candidate;
    } catch { /* try next */ }
  }
  renameLogger.error('Python 3 not found for rope rename');
  throw new Error(
    'Python 3 not found. Install Python 3 and ensure "python3" or "python" is on PATH.',
  );
}

/** Parse a non-zero rope script exit into a thrown Error or handled status. */
function throwRopeFailure(
  label: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  context: Record<string, unknown>,
): never {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.status === 'error') {
      renameLogger.error({ message: parsed.message, ...context }, `${label} returned error status`);
      throw new Error(parsed.message);
    }
  } catch (parseErr) {
    if (parseErr instanceof SyntaxError) {
      renameLogger.error({ exitCode, stderr, stdout: stdout.slice(0, 500), ...context }, `${label} failed with non-JSON output`);
      throw new Error(`${label} failed (exit ${exitCode}): ${stderr || stdout}`);
    }
    throw parseErr;
  }
  renameLogger.error({ exitCode, stderr, stdout: stdout.slice(0, 500), ...context }, `${label} failed`);
  throw new Error(`${label} failed (exit ${exitCode}): ${stderr || stdout}`);
}

/**
 * Find all rename locations for a Python symbol using rope, and optionally apply them.
 *
 * @returns Array of edits, or `null` if the symbol could not be resolved.
 * @throws On infrastructure errors (no Python, rope not installed, syntax errors).
 */
export async function ropeRename(opts: {
  repoPath: string;
  filePath: string;    // relative to repoPath
  line: number;        // 1-based
  column?: number;     // 0-based column of the name node; skip regex when provided and > 0
  oldName: string;
  newName: string;
  dryRun: boolean;
}): Promise<RopeEdit[] | null> {
  const { repoPath, filePath, line, column, oldName, newName, dryRun } = opts;

  if (line < 1) throw new Error(`Invalid line number: ${line} (must be >= 1)`);
  if (!oldName) throw new Error('oldName is required');
  if (!newName) throw new Error('newName is required');

  const python = await findPython();
  const scriptPath = getScriptPath('rope-rename.py');

  const input = JSON.stringify({ repoPath, filePath, line, column: column ?? null, oldName, newName, dryRun });

  const { stdout, stderr, exitCode } = await runPythonScript(python, scriptPath, input, 30000);

  if (exitCode !== 0) {
    // not_found is a clean signal to fall back — check before throwRopeFailure
    try {
      const parsed = JSON.parse(stdout);
      if (parsed.status === 'not_found') {
        renameLogger.debug({ filePath, oldName }, 'Rope could not find symbol');
        return null;
      }
    } catch {
      // fall through to throwRopeFailure
    }
    throwRopeFailure('rope-rename', exitCode, stdout, stderr, { filePath, oldName });
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    renameLogger.error({ err, stdout: stdout.slice(0, 500), filePath, oldName }, 'Rope returned invalid JSON');
    throw new Error(`rope-rename returned invalid JSON: ${stdout.slice(0, 200)}`);
  }

  if (parsed.status === 'not_found') {
    return null;
  }

  if (parsed.status === 'error') {
    renameLogger.error({ message: parsed.message, filePath, oldName }, 'Rope returned error');
    throw new Error(parsed.message);
  }

  if (parsed.status === 'edits') {
    const edits: RopeEdit[] = parsed.edits;
    // Validate edit structure
    for (const edit of edits) {
      if (!edit.filePath || !edit.line || edit.old_text == null || edit.new_text == null) {
        renameLogger.error({ edit, filePath, oldName }, 'Rope returned malformed edit');
        throw new Error(`rope-rename returned malformed edit: ${JSON.stringify(edit)}`);
      }
    }
    return edits.length > 0 ? edits : null;
  }

  renameLogger.error({ status: parsed.status, filePath, oldName }, 'Rope returned unexpected status');
  throw new Error(`rope-rename returned unexpected status: ${parsed.status}`);
}

/**
 * Move a Python module (.py file) or package (directory) and rewrite imports.
 *
 * Uses rope's MoveModule / Rename refactorings via scripts/rope-move.py.
 *
 * @throws On infrastructure errors (no Python, rope not installed, refactor failures).
 */
export async function ropeMove(opts: {
  repoPath: string;
  oldPath: string;  // relative to repoPath — file or directory
  newPath: string;  // relative to repoPath
  dryRun: boolean;
  sourceFolders?: string[];
}): Promise<RopeMoveResult> {
  const { repoPath, oldPath, newPath, dryRun, sourceFolders } = opts;

  if (!oldPath) throw new Error('oldPath is required');
  if (!newPath) throw new Error('newPath is required');

  const python = await findPython();
  const scriptPath = getScriptPath('rope-move.py');

  const input = JSON.stringify({
    repoPath,
    oldPath,
    newPath,
    dryRun,
    sourceFolders: sourceFolders ?? null,
  });

  // Module moves scan the project — longer budget than symbol rename.
  // dry-run is isolated (sandbox) so timeout cannot corrupt the real tree.
  const { stdout, stderr, exitCode } = await runPythonScript(
    python,
    scriptPath,
    input,
    ROPE_MOVE_TIMEOUT_MS,
  );

  if (exitCode !== 0) {
    throwRopeFailure('rope-move', exitCode, stdout, stderr, { oldPath, newPath });
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    renameLogger.error({ err, stdout: stdout.slice(0, 500), oldPath, newPath }, 'rope-move returned invalid JSON');
    throw new Error(`rope-move returned invalid JSON: ${stdout.slice(0, 200)}`);
  }

  if (parsed.status === 'error') {
    renameLogger.error({ message: parsed.message, oldPath, newPath }, 'rope-move returned error');
    throw new Error(parsed.message);
  }

  if (parsed.status !== 'ok') {
    renameLogger.error({ status: parsed.status, oldPath, newPath }, 'rope-move returned unexpected status');
    throw new Error(`rope-move returned unexpected status: ${parsed.status}`);
  }

  const edits: RopeEdit[] = Array.isArray(parsed.edits) ? parsed.edits : [];
  const filesMoved: { from: string; to: string }[] = Array.isArray(parsed.files_moved)
    ? parsed.files_moved
    : [];

  for (const edit of edits) {
    if (!edit.filePath || !edit.line || edit.old_text == null || edit.new_text == null) {
      renameLogger.error({ edit, oldPath, newPath }, 'rope-move returned malformed edit');
      throw new Error(`rope-move returned malformed edit: ${JSON.stringify(edit)}`);
    }
    // Normalize confidence
    edit.confidence = 'rope';
  }

  for (const move of filesMoved) {
    if (!move.from || !move.to) {
      renameLogger.error({ move, oldPath, newPath }, 'rope-move returned malformed files_moved entry');
      throw new Error(`rope-move returned malformed files_moved entry: ${JSON.stringify(move)}`);
    }
  }

  // Always report at least the primary move
  if (filesMoved.length === 0) {
    filesMoved.push({ from: oldPath, to: newPath });
  }

  return { edits, files_moved: filesMoved };
}
