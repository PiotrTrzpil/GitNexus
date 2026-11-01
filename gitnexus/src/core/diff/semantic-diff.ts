/**
 * Symbol-level semantic diff with breaking-change detection.
 *
 * Compares the symbols of a file before and after a change and classifies each
 * one as Added / Removed / Renamed / SignatureChanged / VisibilityChanged /
 * BodyChanged. A change is breaking when the symbol was exported before and it
 * was removed, renamed, had its signature changed, or lost its export. Added
 * symbols, body-only changes and newly gained exports are never breaking.
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  extractDefinitionsFromSource,
  type ExtractResult,
  type SourceDefinition,
} from './definitions-from-source.js';

export type SemanticChangeKind =
  'Added' | 'Removed' | 'Renamed' | 'SignatureChanged' | 'VisibilityChanged' | 'BodyChanged';

/** One changed symbol, shaped for an AI agent: short keys, optional fields omitted. */
export interface SemanticChange {
  change: SemanticChangeKind;
  type: string;
  name: string;
  file: string;
  breaking: boolean;
  /** Previous name, for renames. */
  old_name?: string;
  /** Previous signature, when the signature differs. */
  from?: string;
  /** New signature, when the signature differs. */
  to?: string;
}

export interface SemanticDiffSummary {
  changes: SemanticChange[];
  breaking_count: number;
  files_analyzed: number;
  /** Changed files with a known language that could not be analysed, with the reason. */
  skipped: { file: string; reason: string }[];
  /** True when the number of analysed files hit the cap. */
  truncated?: boolean;
}

/** Files analysed per run; each is parsed twice. */
export const SEMANTIC_DIFF_MAX_FILES = 200;
const MAX_SOURCE_BYTES = 1024 * 1024;

const display = (d: SourceDefinition): string => (d.owner ? `${d.owner}.${d.name}` : d.name);

/** Name masked out, so a pure rename compares equal. */
const masked = (d: SourceDefinition): string => d.text.split(d.name).join('\u0000');

function classify(
  od: SourceDefinition,
  nd: SourceDefinition,
): { kind: SemanticChangeKind; sigChanged: boolean } | null {
  const sigChanged = od.signature !== nd.signature;
  if (sigChanged) return { kind: 'SignatureChanged', sigChanged };
  if (od.isExported !== nd.isExported) return { kind: 'VisibilityChanged', sigChanged };
  if (od.text !== nd.text) return { kind: 'BodyChanged', sigChanged };
  return null;
}

function isBreaking(
  kind: SemanticChangeKind,
  od: SourceDefinition,
  nd?: SourceDefinition,
): boolean {
  if (!od.isExported) return false;
  switch (kind) {
    case 'Removed':
    case 'Renamed':
    case 'SignatureChanged':
      return true;
    case 'VisibilityChanged':
      // Losing export breaks callers; gaining it is additive.
      return nd ? !nd.isExported : true;
    default:
      return false;
  }
}

/**
 * Diff two versions of one file's definitions. Pure; exported for tests.
 * Renames are detected conservatively: same label and owner, a single
 * unambiguous partner, and either an identical body once the name is masked
 * or an identical parameter list on a callable.
 */
export function diffDefinitions(
  oldDefs: SourceDefinition[],
  newDefs: SourceDefinition[],
  file: string,
): SemanticChange[] {
  const changes: SemanticChange[] = [];
  const newByKey = new Map(newDefs.map((d) => [d.key, d]));
  const oldByKey = new Map(oldDefs.map((d) => [d.key, d]));

  for (const od of oldDefs) {
    const nd = newByKey.get(od.key);
    if (!nd) continue;
    const result = classify(od, nd);
    if (!result) continue;
    changes.push({
      change: result.kind,
      type: nd.label,
      name: display(nd),
      file,
      breaking: isBreaking(result.kind, od, nd),
      ...(result.sigChanged && { from: od.signature, to: nd.signature }),
    });
  }

  const unmatchedOld = oldDefs.filter((d) => !newByKey.has(d.key));
  const unmatchedNew = newDefs.filter((d) => !oldByKey.has(d.key));

  const isCandidate = (od: SourceDefinition, nd: SourceDefinition): boolean =>
    od.label === nd.label &&
    od.owner === nd.owner &&
    (masked(od) === masked(nd) ||
      (od.paramCount > 0 && od.signature === nd.signature && od.signature !== ''));

  const renamedOld = new Set<SourceDefinition>();
  const renamedNew = new Set<SourceDefinition>();
  for (const od of unmatchedOld) {
    const partners = unmatchedNew.filter((nd) => isCandidate(od, nd));
    if (partners.length !== 1) continue;
    const nd = partners[0];
    // The partner must also have exactly one candidate, or the pairing is a guess.
    if (unmatchedOld.filter((o) => isCandidate(o, nd)).length !== 1) continue;
    renamedOld.add(od);
    renamedNew.add(nd);
    changes.push({
      change: 'Renamed',
      type: nd.label,
      name: display(nd),
      old_name: display(od),
      file,
      breaking: isBreaking('Renamed', od, nd),
      ...(od.signature !== nd.signature && { from: od.signature, to: nd.signature }),
    });
  }

  for (const od of unmatchedOld) {
    if (renamedOld.has(od)) continue;
    changes.push({
      change: 'Removed',
      type: od.label,
      name: display(od),
      file,
      breaking: isBreaking('Removed', od),
    });
  }
  for (const nd of unmatchedNew) {
    if (renamedNew.has(nd)) continue;
    changes.push({
      change: 'Added',
      type: nd.label,
      name: display(nd),
      file,
      breaking: false,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Reading the two sides from git / the working tree
// ---------------------------------------------------------------------------

/** Where each side of a `detect_changes` scope lives. `index` is the staging area. */
type Side = { from: 'worktree' } | { from: 'git'; ref: string };

export function sidesForScope(scope: string, baseRef?: string): { old: Side; new: Side } {
  switch (scope) {
    case 'staged':
      return { old: { from: 'git', ref: 'HEAD' }, new: { from: 'git', ref: '' } };
    case 'all':
      return { old: { from: 'git', ref: 'HEAD' }, new: { from: 'worktree' } };
    case 'compare':
      return { old: { from: 'git', ref: baseRef ?? 'HEAD' }, new: { from: 'worktree' } };
    default:
      return { old: { from: 'git', ref: '' }, new: { from: 'worktree' } };
  }
}

async function readSide(cwd: string, side: Side, file: string): Promise<string | null> {
  if (side.from === 'worktree') {
    try {
      return await readFile(path.join(cwd, file), 'utf8');
    } catch {
      return null;
    }
  }
  try {
    // `ref:path` reads a commit; an empty ref (`:path`) reads the index.
    return execFileSync('git', ['show', `${side.ref}:${file}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

export interface SemanticDiffFile {
  filePath: string;
  /** Pre-rename path, when git reported a rename. */
  oldFilePath?: string;
}

/**
 * Semantic diff for the files a `detect_changes` run found changed.
 * Files in unsupported languages, binary-sized files and unreadable files are
 * listed under `skipped` rather than failing the run.
 */
export async function computeSemanticDiff(
  cwd: string,
  files: readonly SemanticDiffFile[],
  scope: string,
  baseRef?: string,
): Promise<SemanticDiffSummary> {
  const sides = sidesForScope(scope, baseRef);
  const changes: SemanticChange[] = [];
  const skipped: { file: string; reason: string }[] = [];
  let analyzed = 0;
  const selected = files.slice(0, SEMANTIC_DIFF_MAX_FILES);

  for (const { filePath, oldFilePath } of selected) {
    const [oldSource, newSource] = await Promise.all([
      readSide(cwd, sides.old, oldFilePath ?? filePath),
      readSide(cwd, sides.new, filePath),
    ]);
    if (oldSource === null && newSource === null) continue;
    if (
      (oldSource?.length ?? 0) > MAX_SOURCE_BYTES ||
      (newSource?.length ?? 0) > MAX_SOURCE_BYTES
    ) {
      skipped.push({ file: filePath, reason: 'file too large' });
      continue;
    }

    const [oldRes, newRes] = await Promise.all([
      oldSource === null ? null : extractDefinitionsFromSource(oldFilePath ?? filePath, oldSource),
      newSource === null ? null : extractDefinitionsFromSource(filePath, newSource),
    ]);
    const failed = [oldRes, newRes].find(
      (r): r is Extract<ExtractResult, { supported: false }> => r !== null && !r.supported,
    );
    if (failed) {
      // "unknown language" is a non-source file (docs, config): not worth reporting.
      if (failed.reason !== 'unknown language') {
        skipped.push({ file: filePath, reason: failed.reason });
      }
      continue;
    }
    analyzed++;
    changes.push(
      ...diffDefinitions(
        oldRes?.supported ? oldRes.definitions : [],
        newRes?.supported ? newRes.definitions : [],
        filePath,
      ),
    );
  }

  return {
    changes,
    breaking_count: changes.filter((c) => c.breaking).length,
    files_analyzed: analyzed,
    skipped,
    ...(files.length > selected.length && { truncated: true }),
  };
}
