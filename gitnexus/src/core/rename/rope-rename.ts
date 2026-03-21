/**
 * Rope-powered rename for Python files.
 * Delegates to a Python script that uses the `rope` refactoring library
 * for scope-aware, semantically correct renames.
 *
 * Error contract (mirrors ts-morph-rename):
 * - Returns `null` when the symbol cannot be located (clean signal to fall back).
 * - Throws on infrastructure errors (rope not installed, IO, syntax errors).
 */

import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Run a Python script with JSON on stdin and capture stdout/stderr. */
function runPythonScript(
  python: string,
  scriptPath: string,
  input: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], timeout });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => { resolve({ stdout, stderr, exitCode: code ?? 1 }); });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

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

/** Resolve the path to the rope-rename.py script bundled with this package. */
function getScriptPath(): string {
  // In dist: dist/core/rename/rope-rename.js → ../../scripts/rope-rename.py (relative to package root)
  // We resolve relative to this file's directory
  return path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'rope-rename.py');
}

/** Find a working Python 3 interpreter. */
async function findPython(): Promise<string> {
  for (const candidate of ['python3', 'python']) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 5000 });
      if (stdout.includes('Python 3')) return candidate;
    } catch { /* try next */ }
  }
  throw new Error(
    'Python 3 not found. Install Python 3 and ensure "python3" or "python" is on PATH.',
  );
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
  const scriptPath = getScriptPath();

  const input = JSON.stringify({ repoPath, filePath, line, column: column ?? null, oldName, newName, dryRun });

  const { stdout, stderr, exitCode } = await runPythonScript(python, scriptPath, input, 30000);

  if (exitCode !== 0) {
    // Try to parse structured error from stdout
    try {
      const parsed = JSON.parse(stdout);
      if (parsed.status === 'error') {
        throw new Error(parsed.message);
      }
      if (parsed.status === 'not_found') {
        return null;
      }
    } catch (parseErr) {
      if (parseErr instanceof SyntaxError) {
        // JSON parse failed — use raw output
        throw new Error(`rope-rename failed (exit ${exitCode}): ${stderr || stdout}`);
      }
      throw parseErr; // re-throw our Error from parsed.message
    }
    throw new Error(`rope-rename failed (exit ${exitCode}): ${stderr || stdout}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`rope-rename returned invalid JSON: ${stdout.slice(0, 200)}`);
  }

  if (parsed.status === 'not_found') {
    return null;
  }

  if (parsed.status === 'error') {
    throw new Error(parsed.message);
  }

  if (parsed.status === 'edits') {
    const edits: RopeEdit[] = parsed.edits;
    // Validate edit structure
    for (const edit of edits) {
      if (!edit.filePath || !edit.line || edit.old_text == null || edit.new_text == null) {
        throw new Error(`rope-rename returned malformed edit: ${JSON.stringify(edit)}`);
      }
    }
    return edits.length > 0 ? edits : null;
  }

  throw new Error(`rope-rename returned unexpected status: ${parsed.status}`);
}
