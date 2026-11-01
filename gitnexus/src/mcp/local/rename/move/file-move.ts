/**
 * Move a file or directory and rewrite the imports that reference it.
 *
 * Mirrors the symbol rename contract: a call previews by default, and applying
 * requires the single-use `plan_token` of a reviewed preview. Apply re-plans from
 * the current sources and refuses if the result differs from what was previewed.
 *
 * - TS/JS: ts-morph `SourceFile.move()` in a worker thread (hard timeout).
 * - Python: not supported yet; reported as `unsupported`, nothing is touched.
 * - Other files: plain filesystem move (no import rewriting exists for them).
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { planMoveInWorker, DEFAULT_MOVE_TIMEOUT_MS } from './ts-morph-move-client.js';
import type { MoveEdit, MoveWrite } from './protocol.js';

export type MoveKind = 'file' | 'directory';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const PYTHON_EXTENSIONS = new Set(['.py', '.pyi', '.pyw']);
const MAX_PLANS = 16;
const LIFETIME_MS = 15 * 60 * 1000;

export interface MoveParams {
  repoPath: string;
  kind: MoveKind;
  /** Repo-relative source path. */
  from?: string;
  /** Repo-relative destination path. */
  to?: string;
  dryRun?: boolean;
  planToken?: string;
  timeoutMs?: number;
}

export type MoveFailureCode =
  | 'invalid_request'
  | 'source_missing'
  | 'target_exists'
  | 'unsupported_language'
  | 'plan_required'
  | 'plan_invalid'
  | 'plan_stale'
  | 'planning_failed'
  | 'apply_failed';

export interface MoveResult {
  status: 'success' | 'failed' | 'partial';
  type: MoveKind;
  from?: string;
  to?: string;
  dry_run: boolean;
  applied: boolean;
  plan_token?: string;
  edits?: MoveEdit[];
  edit_count?: number;
  files_moved?: { from: string; to: string }[];
  code?: MoveFailureCode;
  error?: string;
  /** Present on partial applies: what landed before the failure. */
  failed_at?: string;
}

interface RetainedPlan {
  root: string;
  kind: MoveKind;
  from: string;
  to: string;
  fingerprint: string;
  expires: number;
}

const plans = new Map<string, RetainedPlan>();

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const posix = (p: string): string => p.split(path.sep).join('/');

function fail(
  p: Pick<MoveParams, 'kind' | 'from' | 'to'>,
  dryRun: boolean,
  code: MoveFailureCode,
  error: string,
): MoveResult {
  return { status: 'failed', type: p.kind, from: p.from, to: p.to, dry_run: dryRun, applied: false, code, error };
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

async function removeEmptyDirs(dir: string): Promise<void> {
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name));
    }
    await fs.rmdir(dir);
  } catch {
    // not empty or already gone
  }
}

async function removeEmptyParents(file: string, stopAt: string): Promise<void> {
  let dir = path.dirname(file);
  while (isInside(stopAt, dir)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

function prune(now: number): void {
  for (const [token, plan] of plans) if (plan.expires <= now) plans.delete(token);
  while (plans.size >= MAX_PLANS) {
    const oldest = plans.keys().next().value;
    if (oldest === undefined) break;
    plans.delete(oldest);
  }
}

/** Drop retained plans (tests). */
export function clearMovePlans(): void {
  plans.clear();
}

interface Computed {
  edits: MoveEdit[];
  writes: MoveWrite[];
  moves: { from: string; to: string; ts: boolean }[];
  fingerprint: string;
}

async function compute(
  root: string,
  kind: MoveKind,
  absFrom: string,
  absTo: string,
  timeoutMs: number,
): Promise<Computed | { code: MoveFailureCode; error: string }> {
  const files = kind === 'file' ? [absFrom] : await collectFiles(absFrom);
  const python = files.filter((f) => PYTHON_EXTENSIONS.has(path.extname(f)));
  if (python.length > 0) {
    return {
      code: 'unsupported_language',
      error: `Moving Python files or directories containing them is not supported yet (import rewriting for Python is unavailable): ${python
        .slice(0, 3)
        .map((f) => posix(path.relative(root, f)))
        .join(', ')}${python.length > 3 ? ', ...' : ''}. Nothing was changed.`,
    };
  }
  const tsFiles = files.filter((f) => TS_EXTENSIONS.has(path.extname(f)));
  const targetOf = (f: string): string => (kind === 'file' ? absTo : path.join(absTo, path.relative(absFrom, f)));
  const moves = files.map((f) => ({
    from: f,
    to: targetOf(f),
    ts: TS_EXTENSIONS.has(path.extname(f)),
  }));

  let edits: MoveEdit[] = [];
  let writes: MoveWrite[] = [];
  if (tsFiles.length > 0) {
    try {
      ({ edits, writes } = await planMoveInWorker(
        { repoPath: root, from: absFrom, to: absTo, kind, tsFiles },
        timeoutMs,
      ));
    } catch (err) {
      return { code: 'planning_failed', error: err instanceof Error ? err.message : String(err) };
    }
  }
  const fingerprint = sha(
    JSON.stringify({
      kind,
      from: absFrom,
      to: absTo,
      moves: moves.map((m) => [m.from, m.to]),
      writes: writes.map((w) => [w.path, sha(w.text)]).sort(),
    }),
  );
  return { edits, writes, moves, fingerprint };
}

/** Preview (default) or apply a file/directory move. */
export async function moveRename(params: MoveParams): Promise<MoveResult> {
  const { repoPath, kind } = params;
  const dryRun = params.dryRun !== false;
  const timeoutMs = params.timeoutMs ?? DEFAULT_MOVE_TIMEOUT_MS;
  const ref = { kind, from: params.from, to: params.to };

  if (!params.from || !params.to) {
    return fail(ref, dryRun, 'invalid_request', 'Moving needs `path` (source) and `new_name` (destination path), both relative to the repository root.');
  }
  const root = path.resolve(repoPath);
  const absFrom = path.resolve(root, params.from);
  const absTo = path.resolve(root, params.to);
  if (!isInside(root, absFrom) || !isInside(root, absTo)) {
    return fail(ref, dryRun, 'invalid_request', 'Source and destination must be inside the repository.');
  }
  if (absFrom === absTo || (kind === 'directory' && isInside(absFrom, absTo))) {
    return fail(ref, dryRun, 'invalid_request', 'Destination must differ from the source and cannot be inside it.');
  }
  if (!dryRun && !params.planToken) {
    return fail(ref, dryRun, 'plan_required', 'Apply requires plan_token from a successful move preview. Preview and review the exact edits first.');
  }

  let stat;
  try {
    stat = await fs.stat(absFrom);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return fail(ref, dryRun, 'source_missing', `${params.from} does not exist.`);
  }
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    return fail(ref, dryRun, 'invalid_request', `${params.from} is not a ${kind}.`);
  }
  if (await exists(absTo)) {
    return fail(ref, dryRun, 'target_exists', `${params.to} already exists.`);
  }

  // Single-use: a token is spent by the first apply attempt, successful or not.
  let retained: RetainedPlan | undefined;
  if (!dryRun) {
    retained = plans.get(params.planToken!);
    plans.delete(params.planToken!);
    if (
      !retained ||
      retained.expires <= Date.now() ||
      retained.root !== root ||
      retained.kind !== kind ||
      retained.from !== absFrom ||
      retained.to !== absTo
    ) {
      return fail(ref, dryRun, 'plan_invalid', 'plan_token is unknown, expired, already used, or was issued for a different repository, source or destination. Request a fresh preview.');
    }
  }

  const computed = await compute(root, kind, absFrom, absTo, timeoutMs);
  if ('code' in computed) return fail(ref, dryRun, computed.code, computed.error);

  const filesMoved = computed.moves.map((m) => ({
    from: posix(path.relative(root, m.from)),
    to: posix(path.relative(root, m.to)),
  }));
  const base = {
    type: kind,
    from: params.from,
    to: params.to,
    edits: computed.edits,
    edit_count: computed.edits.length,
    files_moved: filesMoved,
  };

  if (dryRun) {
    prune(Date.now());
    const token = randomBytes(24).toString('hex');
    plans.set(token, {
      root,
      kind,
      from: absFrom,
      to: absTo,
      fingerprint: computed.fingerprint,
      expires: Date.now() + LIFETIME_MS,
    });
    return { status: 'success', dry_run: true, applied: false, plan_token: token, ...base };
  }

  if (retained!.fingerprint !== computed.fingerprint) {
    return fail(ref, dryRun, 'plan_stale', 'Sources changed since the preview, so the reviewed edits no longer match. Request a fresh preview.');
  }

  let current = '';
  try {
    for (const w of computed.writes) {
      current = w.path;
      await fs.mkdir(path.dirname(w.path), { recursive: true });
      await fs.writeFile(w.path, w.text);
    }
    for (const m of computed.moves) {
      current = m.from;
      if (m.ts) {
        await fs.unlink(m.from);
      } else {
        await fs.mkdir(path.dirname(m.to), { recursive: true });
        await fs.rename(m.from, m.to);
      }
    }
    if (kind === 'directory') await removeEmptyDirs(absFrom);
    else await removeEmptyParents(absFrom, root);
  } catch (err) {
    return {
      status: 'partial',
      dry_run: false,
      applied: false,
      code: 'apply_failed',
      error: `${err instanceof Error ? err.message : String(err)}. The move may be partly applied; inspect the working tree (git status) before retrying.`,
      failed_at: posix(path.relative(root, current)),
      ...base,
    };
  }
  return { status: 'success', dry_run: false, applied: true, ...base };
}
