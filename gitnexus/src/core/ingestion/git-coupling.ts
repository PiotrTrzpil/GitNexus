import { execSync } from 'child_process';
import type { KnowledgeGraph } from '../graph/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChangeCoupling {
  fileA: string;
  fileB: string;
  coChangeCount: number;
  totalChangesA: number;
  totalChangesB: number;
  couplingScore: number;     // coChangeCount / min(totalChangesA, totalChangesB)
}

interface CommitFiles {
  hash: string;
  files: string[];
}

// ─── Skip filters (ported from githistory.go isTrackableFile) ─────────────────

const SKIP_PREFIXES = ['.git/', 'node_modules/', 'vendor/', '__pycache__/'];

const SKIP_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
  'Gemfile.lock',
  'Pipfile.lock',
]);

const SKIP_SUFFIXES = ['.lock', '.sum', '.min.js', '.min.css', '.map', '.wasm', '.png', '.jpg', '.gif', '.ico', '.svg'];

function isTrackableFile(filePath: string): boolean {
  for (const prefix of SKIP_PREFIXES) {
    if (filePath.startsWith(prefix)) return false;
  }

  const slashIdx = filePath.lastIndexOf('/');
  const base = slashIdx >= 0 ? filePath.slice(slashIdx + 1) : filePath;
  if (SKIP_NAMES.has(base)) return false;

  for (const suffix of SKIP_SUFFIXES) {
    if (filePath.endsWith(suffix)) return false;
  }

  return true;
}

// ─── Git log parsing (ported from githistory.go parseGitLog) ─────────────────

/**
 * Run `git log --name-only --pretty=format:COMMIT:%H --since="6 months ago"`
 * and parse the output into an array of CommitFiles.
 */
export function parseGitLog(repoPath: string): CommitFiles[] {
  let output: string;
  try {
    output = execSync(
      'git log --name-only --pretty=format:COMMIT:%H --since="6 months ago"',
      { cwd: repoPath, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (err) {
    throw new Error(`git log failed: ${(err as Error).message}`);
  }

  const commits: CommitFiles[] = [];
  let current: CommitFiles | null = null;

  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;

    if (line.startsWith('COMMIT:')) {
      if (current !== null && current.files.length > 0) {
        commits.push(current);
      }
      current = { hash: line.slice('COMMIT:'.length), files: [] };
      continue;
    }

    if (current !== null && isTrackableFile(line)) {
      current.files.push(line);
    }
  }

  if (current !== null && current.files.length > 0) {
    commits.push(current);
  }

  return commits;
}

// ─── Co-change counting (ported from githistory.go computeChangeCoupling) ─────

/**
 * Count how often each pair of files changes together across commits.
 * Skips commits with >20 files (large merges / refactor commits).
 * Applies thresholds: coChangeCount >= 3, couplingScore >= 0.3.
 * Returns top 100 couplings sorted by descending score.
 */
export function computeChangeCoupling(commits: CommitFiles[]): ChangeCoupling[] {
  const fileChangeCount = new Map<string, number>();
  const pairCount = new Map<string, number>();

  for (const commit of commits) {
    const files = commit.files;
    if (files.length > 20) continue; // skip large merge/refactor commits

    for (const f of files) {
      fileChangeCount.set(f, (fileChangeCount.get(f) ?? 0) + 1);
    }

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        // Canonical order: lexicographically smaller first
        const a = files[i] < files[j] ? files[i] : files[j];
        const b = files[i] < files[j] ? files[j] : files[i];
        const key = `${a}\0${b}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }

  const couplings: ChangeCoupling[] = [];

  for (const [key, count] of pairCount) {
    if (count < 3) continue;

    const sep = key.indexOf('\0');
    const fileA = key.slice(0, sep);
    const fileB = key.slice(sep + 1);

    const totalA = fileChangeCount.get(fileA)!;
    const totalB = fileChangeCount.get(fileB)!;
    const minTotal = Math.min(totalA, totalB);

    const score = count / minTotal;
    if (score < 0.3) continue;

    couplings.push({
      fileA,
      fileB,
      coChangeCount: count,
      totalChangesA: totalA,
      totalChangesB: totalB,
      couplingScore: score,
    });
  }

  // Sort descending by coupling score
  couplings.sort((a, b) => b.couplingScore - a.couplingScore);

  // Top 100
  return couplings.slice(0, 100);
}

// ─── Graph edge creation ──────────────────────────────────────────────────────

/**
 * Create FILE_CHANGES_WITH edges in the graph for each detected coupling.
 * Edges go between File nodes; the coupling metadata is encoded in `reason`.
 * Returns the number of edges created.
 */
export function createCouplingEdges(graph: KnowledgeGraph, couplings: ChangeCoupling[]): number {
  // Build a fast lookup: filePath → File node id
  const fileNodeById = new Map<string, string>();
  graph.forEachNode(node => {
    if (node.label === 'File') {
      fileNodeById.set(node.properties.filePath, node.id);
    }
  });

  let count = 0;
  for (const c of couplings) {
    const sourceId = fileNodeById.get(c.fileA);
    const targetId = fileNodeById.get(c.fileB);
    if (!sourceId || !targetId) continue;

    graph.addRelationship({
      id: `file_coupling_${c.fileA}\0${c.fileB}`,
      type: 'FILE_CHANGES_WITH' as any,   // schema extension — added by another agent
      sourceId,
      targetId,
      confidence: c.couplingScore,
      reason: `co-change:${c.coChangeCount}/${c.totalChangesA},${c.totalChangesB}`,
    });

    count++;
  }

  return count;
}

// ─── Pipeline entry point ─────────────────────────────────────────────────────

/**
 * Mine git history for co-change coupling and insert FILE_CHANGES_WITH edges.
 * Intended to run after community detection (before process detection).
 *
 * @returns number of edges added, or 0 if the repo has no qualifying history.
 */
export async function passGitCoupling(repoPath: string, graph: KnowledgeGraph): Promise<number> {
  const commits = parseGitLog(repoPath);

  if (commits.length === 0) {
    return 0;
  }

  const couplings = computeChangeCoupling(commits);
  if (couplings.length === 0) {
    return 0;
  }

  const edgeCount = createCouplingEdges(graph, couplings);
  return edgeCount;
}
