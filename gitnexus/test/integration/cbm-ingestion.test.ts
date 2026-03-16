import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import {
  parseGitLog,
  computeChangeCoupling,
  createCouplingEdges,
} from '../../src/core/ingestion/git-coupling.js';

import {
  computeFileHash,
  classifyFiles,
  findDependentFiles,
} from '../../src/core/ingestion/incremental.js';

import {
  loadFileHashes,
  saveFileHashes,
  getFileHashesPath,
} from '../../src/storage/file-hashes.js';

import { buildTestGraph } from '../helpers/test-graph.js';

// ─── Shared temp dirs ────────────────────────────────────────────────────────

const GITNEXUS_REPO = '/Users/subuser/Code/GitNexus';

let tmpHashDir: string;
let tmpFileDir: string;

beforeAll(async () => {
  tmpHashDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-cbm-hashes-'));
  tmpFileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-cbm-files-'));

  // Create a real file we can hash
  await fs.writeFile(path.join(tmpFileDir, 'sample.ts'), 'export const foo = 42;\n', 'utf-8');
});

afterAll(async () => {
  for (const dir of [tmpHashDir, tmpFileDir]) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

// ─── Git Change Coupling ──────────────────────────────────────────────────────

describe('git-coupling: parseGitLog', () => {
  it('returns non-empty commits from a real git repo', { timeout: 30000 }, async () => {
    const commits = parseGitLog(GITNEXUS_REPO);
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits.slice(0, 5)) {
      expect(typeof commit.hash).toBe('string');
      expect(commit.hash.length).toBeGreaterThan(0);
      expect(Array.isArray(commit.files)).toBe(true);
      expect(commit.files.length).toBeGreaterThan(0);
    }
  });

  it('throws when given a non-git directory', { timeout: 10000 }, () => {
    expect(() => parseGitLog(os.tmpdir())).toThrow();
  });

  it('excludes skip-filtered paths from commit file lists', { timeout: 30000 }, () => {
    const commits = parseGitLog(GITNEXUS_REPO);
    const allFiles = commits.flatMap(c => c.files);

    // No node_modules, .git, or lock files should survive the filter
    expect(allFiles.every(f => !f.startsWith('node_modules/'))).toBe(true);
    expect(allFiles.every(f => !f.startsWith('.git/'))).toBe(true);
    expect(allFiles.every(f => !f.endsWith('package-lock.json'))).toBe(true);
  });
});

describe('git-coupling: computeChangeCoupling', () => {
  it('detects strongly coupled files (score = 1.0)', () => {
    // a.ts and b.ts co-change in 5 commits — well above the min=3 threshold
    const commits = Array.from({ length: 5 }, (_, i) => ({
      hash: `hash${i}`,
      files: ['a.ts', 'b.ts'],
    }));
    const couplings = computeChangeCoupling(commits);
    const pair = couplings.find(
      c => (c.fileA === 'a.ts' && c.fileB === 'b.ts') || (c.fileA === 'b.ts' && c.fileB === 'a.ts'),
    );
    expect(pair).toBeDefined();
    expect(pair!.couplingScore).toBeCloseTo(1.0);
    expect(pair!.coChangeCount).toBe(5);
  });

  it('does not couple files that appear together only once', () => {
    // a.ts + b.ts appear 5 times; c.ts appears only once alongside a.ts
    const commits = [
      ...Array.from({ length: 5 }, (_, i) => ({ hash: `ab${i}`, files: ['a.ts', 'b.ts'] })),
      { hash: 'ac0', files: ['a.ts', 'c.ts'] },
    ];
    const couplings = computeChangeCoupling(commits);
    const acPair = couplings.find(
      c => (c.fileA === 'a.ts' || c.fileB === 'a.ts') &&
           (c.fileA === 'c.ts' || c.fileB === 'c.ts'),
    );
    // co-change count for a+c is 1 — below the minimum of 3
    expect(acPair).toBeUndefined();
  });

  it('skips commits with more than 20 files', () => {
    // Build one oversized commit plus 5 normal co-change commits
    const bigCommit = {
      hash: 'big',
      files: Array.from({ length: 21 }, (_, i) => `file${i}.ts`),
    };
    const normalCommits = Array.from({ length: 5 }, (_, i) => ({
      hash: `n${i}`,
      files: ['x.ts', 'y.ts'],
    }));

    // If we pass only the big commit, no files should be counted and no couplings returned
    const couplings = computeChangeCoupling([bigCommit]);
    expect(couplings).toHaveLength(0);

    // The normal commits should still produce a coupling even if mixed with the big commit
    const mixed = computeChangeCoupling([bigCommit, ...normalCommits]);
    const xy = mixed.find(
      c => (c.fileA === 'x.ts' || c.fileB === 'x.ts') &&
           (c.fileA === 'y.ts' || c.fileB === 'y.ts'),
    );
    expect(xy).toBeDefined();
  });

  it('returns an empty array when no pair meets the threshold', () => {
    // Each pair co-changes only twice — below the minimum of 3
    const commits = [
      { hash: 'h1', files: ['p.ts', 'q.ts'] },
      { hash: 'h2', files: ['p.ts', 'q.ts'] },
    ];
    const couplings = computeChangeCoupling(commits);
    expect(couplings).toHaveLength(0);
  });
});

describe('git-coupling: createCouplingEdges', () => {
  it('creates FILE_CHANGES_WITH edges when both File nodes exist', () => {
    const graph = buildTestGraph([
      { id: 'File:a.ts', label: 'File', name: 'a.ts', filePath: 'a.ts' },
      { id: 'File:b.ts', label: 'File', name: 'b.ts', filePath: 'b.ts' },
    ]);

    const couplings = [
      {
        fileA: 'a.ts',
        fileB: 'b.ts',
        coChangeCount: 5,
        totalChangesA: 5,
        totalChangesB: 5,
        couplingScore: 1.0,
      },
    ];

    const count = createCouplingEdges(graph, couplings);
    expect(count).toBe(1);

    const edges = graph.relationships.filter(r => r.type === 'FILE_CHANGES_WITH');
    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBeCloseTo(1.0);
  });

  it('skips edges when a File node is missing from the graph', () => {
    // Only one of the two files has a node
    const graph = buildTestGraph([
      { id: 'File:a.ts', label: 'File', name: 'a.ts', filePath: 'a.ts' },
    ]);

    const couplings = [
      {
        fileA: 'a.ts',
        fileB: 'missing.ts',
        coChangeCount: 5,
        totalChangesA: 5,
        totalChangesB: 5,
        couplingScore: 1.0,
      },
    ];

    const count = createCouplingEdges(graph, couplings);
    expect(count).toBe(0);
    expect(graph.relationships.filter(r => r.type === 'FILE_CHANGES_WITH')).toHaveLength(0);
  });
});

// ─── Incremental Indexing ─────────────────────────────────────────────────────

describe('incremental: computeFileHash', () => {
  it('returns a non-empty hex string for a real file', async () => {
    const filePath = path.join(tmpFileDir, 'sample.ts');
    const hash = await computeFileHash(filePath);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('is deterministic — same file returns same hash twice', async () => {
    const filePath = path.join(tmpFileDir, 'sample.ts');
    const hash1 = await computeFileHash(filePath);
    const hash2 = await computeFileHash(filePath);
    expect(hash1).toBe(hash2);
  });

  it('throws for a non-existent file', async () => {
    await expect(computeFileHash('/non/existent/path/file.ts')).rejects.toThrow();
  });
});

describe('incremental: classifyFiles', () => {
  it('marks all files as changed when stored hashes are empty (first index)', async () => {
    const scanned = [
      { path: path.join(tmpFileDir, 'sample.ts'), size: 22 },
    ];
    const { changedPaths, unchangedPaths } = await classifyFiles(
      tmpFileDir,
      scanned,
      new Map(),
    );
    expect(changedPaths).toHaveLength(1);
    expect(unchangedPaths).toHaveLength(0);
  });

  it('marks files as unchanged when stored hash matches current content', async () => {
    const filePath = path.join(tmpFileDir, 'sample.ts');
    const hash = await computeFileHash(filePath);
    const relPath = 'sample.ts';

    const scanned = [{ path: filePath, size: 22 }];
    const storedHashes = new Map([[relPath, hash]]);

    const { changedPaths, unchangedPaths } = await classifyFiles(
      tmpFileDir,
      scanned,
      storedHashes,
    );
    expect(unchangedPaths).toHaveLength(1);
    expect(changedPaths).toHaveLength(0);
  });

  it('correctly splits when one file changed and one did not', async () => {
    // Write a second file so we have two to classify
    const stableFile = path.join(tmpFileDir, 'stable.ts');
    await fs.writeFile(stableFile, 'export const stable = true;\n', 'utf-8');

    const stableHash = await computeFileHash(stableFile);
    const sampleFile = path.join(tmpFileDir, 'sample.ts');

    const scanned = [
      { path: sampleFile, size: 22 },
      { path: stableFile, size: 28 },
    ];
    // Store a wrong hash for sample.ts so it looks changed
    const storedHashes = new Map([
      ['sample.ts', 'deadbeefdeadbeef'],
      ['stable.ts', stableHash],
    ]);

    const { changedPaths, unchangedPaths } = await classifyFiles(
      tmpFileDir,
      scanned,
      storedHashes,
    );
    expect(changedPaths).toHaveLength(1);
    expect(changedPaths[0]).toBe(sampleFile);
    expect(unchangedPaths).toHaveLength(1);
    expect(unchangedPaths[0]).toBe(stableFile);
  });
});

describe('incremental: findDependentFiles', () => {
  it('returns unchanged files that import a changed module', () => {
    const changed = ['/repo/src/utils.ts'];
    const unchanged = ['/repo/src/index.ts', '/repo/src/other.ts'];
    const importMap = new Map([
      ['/repo/src/index.ts', new Set(['/repo/src/utils.ts'])],
      ['/repo/src/other.ts', new Set(['/repo/src/unrelated.ts'])],
    ]);

    const dependents = findDependentFiles(changed, unchanged, importMap);
    expect(dependents).toContain('/repo/src/index.ts');
    expect(dependents).not.toContain('/repo/src/other.ts');
  });

  it('returns empty array when there are no changed files', () => {
    const dependents = findDependentFiles([], ['/repo/src/index.ts'], new Map());
    expect(dependents).toHaveLength(0);
  });
});

// ─── File Hashes Storage ──────────────────────────────────────────────────────

describe('file-hashes', () => {
  it('getFileHashesPath returns path inside storage dir', () => {
    const p = getFileHashesPath('/some/storage');
    expect(p).toBe(path.join('/some/storage', 'file-hashes.json'));
  });

  it('saveFileHashes + loadFileHashes roundtrip persists all records', async () => {
    const hashes = [
      { relPath: 'src/index.ts', hash: 'aabbccddeeff0011' },
      { relPath: 'src/utils.ts', hash: '1122334455667788' },
    ];
    await saveFileHashes(tmpHashDir, hashes);

    const loaded = await loadFileHashes(tmpHashDir);
    expect(loaded.size).toBe(2);
    expect(loaded.get('src/index.ts')).toBe('aabbccddeeff0011');
    expect(loaded.get('src/utils.ts')).toBe('1122334455667788');
  });

  it('loadFileHashes returns empty Map for non-existent storage path', async () => {
    const nonExistent = path.join(os.tmpdir(), `gn-no-such-dir-${Date.now()}`);
    const loaded = await loadFileHashes(nonExistent);
    expect(loaded).toBeInstanceOf(Map);
    expect(loaded.size).toBe(0);
  });

  it('loadFileHashes throws on corrupted JSON (not silently empty)', async () => {
    const corruptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-corrupt-'));
    try {
      await fs.writeFile(
        path.join(corruptDir, 'file-hashes.json'),
        '{ this is not valid JSON !!!',
        'utf-8',
      );
      await expect(loadFileHashes(corruptDir)).rejects.toThrow();
    } finally {
      await fs.rm(corruptDir, { recursive: true, force: true });
    }
  });
});
