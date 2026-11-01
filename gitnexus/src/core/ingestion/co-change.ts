/**
 * Co-change mining: "files that usually change together".
 *
 * Static analysis cannot see the link between a backend router and its
 * frontend client, a schema and its migration, or a module and its docs. Git
 * history can: those files keep landing in the same commits.
 *
 * One bounded `git log --name-only` is parsed into commits, scored, and
 * reduced to a small set of File↔File pairs. Everything here is pure except
 * {@link readGitCommits}.
 *
 * Strength of a pair = coCount / min(changes of A, changes of B): the fraction
 * of the less-active file's history in which the other file was touched too.
 */
import { execFile } from 'node:child_process';

/** Most recent commits read from history. */
export const CO_CHANGE_MAX_COMMITS = 2000;
/** Wall-clock budget for the `git log` call. */
export const CO_CHANGE_GIT_TIMEOUT_MS = 15_000;
/** Commits touching more files than this (mass renames, formatting) carry no signal. */
export const CO_CHANGE_MAX_FILES_PER_COMMIT = 50;
/** A pair must have changed together at least this many times. */
export const CO_CHANGE_MIN_SUPPORT = 3;
/** ...and in at least this fraction of the less-active file's changes. */
export const CO_CHANGE_MIN_STRENGTH = 0.3;
/** Partners kept per file (an edge survives if it is in either endpoint's top N). */
export const CO_CHANGE_TOP_PARTNERS = 5;

export interface CoChangeOptions {
  maxFilesPerCommit?: number;
  minSupport?: number;
  minStrength?: number;
  topPartners?: number;
}

export interface CoChangePair {
  /** Lexicographically smaller path. */
  fileA: string;
  fileB: string;
  /** Commits that touched both files. */
  count: number;
  /** count / min(changes of A, changes of B), in (0, 1]. */
  strength: number;
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const COMMIT_SEPARATOR = '\u0001';

/**
 * Read the file lists of the last `maxCommits` non-merge commits touching the
 * repo directory. Paths are relative to `repoPath` (also when it is a
 * subdirectory of a larger repository). Returns `null` when git is missing,
 * `repoPath` is not in a git repository, the repository has no commits, or the
 * call exceeds the time budget; callers skip the feature in that case.
 */
export function readGitCommits(
  repoPath: string,
  maxCommits: number = CO_CHANGE_MAX_COMMITS,
  timeoutMs: number = CO_CHANGE_GIT_TIMEOUT_MS,
): Promise<string[][] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [
        '-c',
        'core.quotepath=false',
        'log',
        `-n${maxCommits}`,
        '--no-merges',
        '--no-renames',
        '--name-only',
        `--pretty=format:${COMMIT_SEPARATOR}`,
        '--relative',
        '--',
        '.',
      ],
      { cwd: repoPath, timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve(parseGitLog(stdout));
      },
    );
  });
}

/** Parse the output of {@link readGitCommits}'s git invocation. */
export function parseGitLog(stdout: string): string[][] {
  const commits: string[][] = [];
  for (const chunk of stdout.split(COMMIT_SEPARATOR)) {
    const files = chunk.split('\n').filter((line) => line.length > 0);
    if (files.length > 0) commits.push(files);
  }
  return commits;
}

/**
 * Score co-changing file pairs.
 *
 * @param commits     file lists, one per commit
 * @param isIndexed   keeps only files present in the graph
 *
 * A commit is skipped whole when it touches more than `maxFilesPerCommit`
 * files (counted before the indexed filter: the size of a commit says whether
 * it was a sweeping change, whatever the indexer later keeps).
 */
export function computeCoChangePairs(
  commits: readonly (readonly string[])[],
  isIndexed: (filePath: string) => boolean,
  options: CoChangeOptions = {},
): CoChangePair[] {
  const maxFiles = options.maxFilesPerCommit ?? CO_CHANGE_MAX_FILES_PER_COMMIT;
  const minSupport = options.minSupport ?? CO_CHANGE_MIN_SUPPORT;
  const minStrength = options.minStrength ?? CO_CHANGE_MIN_STRENGTH;
  const topPartners = options.topPartners ?? CO_CHANGE_TOP_PARTNERS;

  const changes = new Map<string, number>();
  const together = new Map<string, number>();

  for (const commit of commits) {
    if (commit.length > maxFiles) continue;
    const files = [...new Set(commit)].filter(isIndexed).sort();
    for (const file of files) changes.set(file, (changes.get(file) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\0${files[j]}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  }

  const scored: CoChangePair[] = [];
  for (const [key, count] of together) {
    if (count < minSupport) continue;
    const split = key.indexOf('\0');
    const fileA = key.slice(0, split);
    const fileB = key.slice(split + 1);
    const strength = count / Math.min(changes.get(fileA)!, changes.get(fileB)!);
    if (strength < minStrength) continue;
    scored.push({ fileA, fileB, count, strength });
  }

  // Strongest first; ties broken by support then path so output is deterministic.
  scored.sort(
    (x, y) =>
      y.strength - x.strength ||
      y.count - x.count ||
      (x.fileA < y.fileA ? -1 : x.fileA > y.fileA ? 1 : 0) ||
      (x.fileB < y.fileB ? -1 : x.fileB > y.fileB ? 1 : 0),
  );

  // Keep a pair when it ranks within the top N partners of either endpoint.
  const taken = new Map<string, number>();
  const kept: CoChangePair[] = [];
  for (const pair of scored) {
    const a = taken.get(pair.fileA) ?? 0;
    const b = taken.get(pair.fileB) ?? 0;
    if (a >= topPartners && b >= topPartners) continue;
    if (a < topPartners) taken.set(pair.fileA, a + 1);
    if (b < topPartners) taken.set(pair.fileB, b + 1);
    kept.push(pair);
  }
  return kept;
}
