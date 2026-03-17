/**
 * Integration Tests: Incremental Indexing
 *
 * Verifies that the incremental indexing pipeline:
 *  1. First run: hashes all files and persists file-hashes.json
 *  2. Re-run (no changes): classifies all files as unchanged
 *  3. Re-run (one file changed): only the modified file is re-parsed
 *
 * Uses a temporary copy of the mini-repo fixture to avoid side effects.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { classifyFiles, computeFileHash } from '../../src/core/ingestion/incremental.js';
import { loadFileHashes, saveFileHashes, getFileHashesPath } from '../../src/storage/file-hashes.js';
import { loadParseCache, saveParseCache, getParseCachePath, type CachedFileResult } from '../../src/storage/parse-cache.js';
import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const MINI_REPO = path.resolve(__dirname, '..', 'fixtures', 'mini-repo');

describe('incremental indexing', () => {
  let tmpRepo: string;
  let storagePath: string;

  beforeAll(async () => {
    // Create a temporary copy of mini-repo so we can mutate files
    tmpRepo = path.join(os.tmpdir(), `gn-incremental-${Date.now()}`);
    await fs.cp(MINI_REPO, tmpRepo, { recursive: true });
    storagePath = path.join(tmpRepo, '.gitnexus');
    await fs.mkdir(storagePath, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tmpRepo, { recursive: true, force: true });
  });

  it('computeFileHash returns a 16-char hex string', async () => {
    const filePath = path.join(tmpRepo, 'src', 'handler.ts');
    const hash = await computeFileHash(filePath);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('computeFileHash is deterministic', async () => {
    const filePath = path.join(tmpRepo, 'src', 'handler.ts');
    const hash1 = await computeFileHash(filePath);
    const hash2 = await computeFileHash(filePath);
    expect(hash1).toBe(hash2);
  });

  it('computeFileHash changes when file content changes', async () => {
    const filePath = path.join(tmpRepo, 'src', 'handler.ts');
    const hashBefore = await computeFileHash(filePath);
    const original = await fs.readFile(filePath, 'utf-8');

    await fs.writeFile(filePath, original + '\n// changed\n', 'utf-8');
    const hashAfter = await computeFileHash(filePath);

    expect(hashAfter).not.toBe(hashBefore);

    // Restore original content
    await fs.writeFile(filePath, original, 'utf-8');
  });

  it('first run: classifies all files as changed (no stored hashes)', async () => {
    const scannedFiles = await walkRepositoryPaths(tmpRepo);
    const storedHashes = new Map<string, string>();

    const result = await classifyFiles(tmpRepo, scannedFiles, storedHashes);

    expect(result.changedPaths.length).toBe(scannedFiles.length);
    expect(result.unchangedPaths.length).toBe(0);
    expect(result.currentHashes.length).toBe(scannedFiles.length);

    // Every hash should be a valid 16-char hex string
    for (const h of result.currentHashes) {
      expect(h.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(h.relPath).not.toMatch(/^\//); // relative, not absolute
    }
  });

  it('second run (no changes): classifies all files as unchanged', async () => {
    const scannedFiles = await walkRepositoryPaths(tmpRepo);

    // First run — compute and save hashes
    const first = await classifyFiles(tmpRepo, scannedFiles, new Map());
    await saveFileHashes(storagePath, first.currentHashes);

    // Second run — load stored hashes, classify again
    const storedHashes = await loadFileHashes(storagePath);
    const second = await classifyFiles(tmpRepo, scannedFiles, storedHashes);

    expect(second.unchangedPaths.length).toBe(scannedFiles.length);
    expect(second.changedPaths.length).toBe(0);
  });

  it('third run (one file modified): only the changed file is re-classified', async () => {
    const scannedFiles = await walkRepositoryPaths(tmpRepo);

    // Baseline — compute and save hashes
    const baseline = await classifyFiles(tmpRepo, scannedFiles, new Map());
    await saveFileHashes(storagePath, baseline.currentHashes);

    // Modify one file
    const targetFile = path.join(tmpRepo, 'src', 'validator.ts');
    const original = await fs.readFile(targetFile, 'utf-8');
    await fs.writeFile(targetFile, original + '\n// incremental test mutation\n', 'utf-8');

    try {
      // Re-classify with stored hashes
      const storedHashes = await loadFileHashes(storagePath);
      const scannedAfter = await walkRepositoryPaths(tmpRepo);
      const incremental = await classifyFiles(tmpRepo, scannedAfter, storedHashes);

      // Only the modified file should appear as changed
      expect(incremental.changedPaths.length).toBe(1);
      expect(incremental.changedPaths[0]).toBe('src/validator.ts');

      // All other files should be unchanged
      expect(incremental.unchangedPaths.length).toBe(scannedAfter.length - 1);
    } finally {
      // Restore original content
      await fs.writeFile(targetFile, original, 'utf-8');
    }
  });

  it('loadFileHashes returns empty map when file does not exist', async () => {
    const emptyDir = path.join(os.tmpdir(), `gn-empty-${Date.now()}`);
    await fs.mkdir(emptyDir, { recursive: true });
    try {
      const hashes = await loadFileHashes(emptyDir);
      expect(hashes.size).toBe(0);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('saveFileHashes + loadFileHashes round-trips correctly', async () => {
    const hashes = [
      { relPath: 'src/foo.ts', hash: '0123456789abcdef' },
      { relPath: 'src/bar.ts', hash: 'fedcba9876543210' },
    ];

    await saveFileHashes(storagePath, hashes);
    const loaded = await loadFileHashes(storagePath);

    expect(loaded.size).toBe(2);
    expect(loaded.get('src/foo.ts')).toBe('0123456789abcdef');
    expect(loaded.get('src/bar.ts')).toBe('fedcba9876543210');
  });

  it('file-hashes.json is written to the expected path', async () => {
    const expectedPath = getFileHashesPath(storagePath);
    expect(expectedPath).toBe(path.join(storagePath, 'file-hashes.json'));

    // Should exist from the previous test
    const stat = await fs.stat(expectedPath);
    expect(stat.isFile()).toBe(true);
  });

  it('new files are detected as changed on re-index', async () => {
    const scannedFiles = await walkRepositoryPaths(tmpRepo);

    // Baseline
    const baseline = await classifyFiles(tmpRepo, scannedFiles, new Map());
    await saveFileHashes(storagePath, baseline.currentHashes);

    // Add a new file
    const newFile = path.join(tmpRepo, 'src', 'new-module.ts');
    await fs.writeFile(newFile, 'export const newThing = 42;\n', 'utf-8');

    try {
      const storedHashes = await loadFileHashes(storagePath);
      const scannedAfter = await walkRepositoryPaths(tmpRepo);
      const incremental = await classifyFiles(tmpRepo, scannedAfter, storedHashes);

      // The new file should be the only changed file
      expect(incremental.changedPaths.length).toBe(1);
      expect(incremental.changedPaths[0]).toBe('src/new-module.ts');
      expect(incremental.unchangedPaths.length).toBe(scannedFiles.length);
    } finally {
      await fs.rm(newFile);
    }
  });

  // ── Parse Cache Tests ─────────────────────────────────────────────────

  it('saveParseCache + loadParseCache round-trips correctly', async () => {
    const cache = new Map<string, CachedFileResult>();
    cache.set('src/handler.ts', {
      nodes: [
        {
          id: 'func_handler',
          label: 'Function',
          properties: {
            name: 'handleRequest',
            filePath: 'src/handler.ts',
            startLine: 1,
            endLine: 10,
            language: 'typescript',
            isExported: true,
          },
        },
      ],
      relationships: [
        {
          id: 'file_defines_func',
          sourceId: 'file_handler',
          targetId: 'func_handler',
          type: 'DEFINES',
          confidence: 1.0,
          reason: 'tree-sitter',
        },
      ],
      symbols: [
        {
          filePath: 'src/handler.ts',
          name: 'handleRequest',
          nodeId: 'func_handler',
          type: 'Function',
        },
      ],
      imports: [
        {
          filePath: 'src/handler.ts',
          rawImportPath: './validator',
          language: 'typescript' as any,
        },
      ],
      calls: [
        {
          filePath: 'src/handler.ts',
          calledName: 'validate',
          sourceId: 'func_handler',
          callForm: 'free',
        },
      ],
      heritage: [],
      routes: [],
      constructorBindings: [],
    });

    await saveParseCache(storagePath, cache);
    const loaded = await loadParseCache(storagePath);

    expect(loaded.size).toBe(1);

    const entry = loaded.get('src/handler.ts');
    expect(entry).toBeDefined();
    expect(entry!.nodes).toHaveLength(1);
    expect(entry!.nodes[0].properties.name).toBe('handleRequest');
    expect(entry!.relationships).toHaveLength(1);
    expect(entry!.symbols).toHaveLength(1);
    expect(entry!.imports).toHaveLength(1);
    expect(entry!.calls).toHaveLength(1);
    expect(entry!.calls[0].calledName).toBe('validate');
  });

  it('parse-cache.json is written to the expected path', async () => {
    const expectedPath = getParseCachePath(storagePath);
    expect(expectedPath).toBe(path.join(storagePath, 'parse-cache.json'));

    // Should exist from the previous test
    const stat = await fs.stat(expectedPath);
    expect(stat.isFile()).toBe(true);
  });

  it('loadParseCache returns empty map when file does not exist', async () => {
    const emptyDir = path.join(os.tmpdir(), `gn-cache-empty-${Date.now()}`);
    await fs.mkdir(emptyDir, { recursive: true });
    try {
      const cache = await loadParseCache(emptyDir);
      expect(cache.size).toBe(0);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('loadParseCache returns empty map for corrupted file', async () => {
    const corruptDir = path.join(os.tmpdir(), `gn-cache-corrupt-${Date.now()}`);
    await fs.mkdir(corruptDir, { recursive: true });
    try {
      await fs.writeFile(path.join(corruptDir, 'parse-cache.json'), 'not valid json!!!', 'utf-8');
      const cache = await loadParseCache(corruptDir);
      expect(cache.size).toBe(0);
    } finally {
      await fs.rm(corruptDir, { recursive: true, force: true });
    }
  });

  it('loadParseCache returns empty map for wrong version', async () => {
    const wrongVerDir = path.join(os.tmpdir(), `gn-cache-ver-${Date.now()}`);
    await fs.mkdir(wrongVerDir, { recursive: true });
    try {
      await fs.writeFile(
        path.join(wrongVerDir, 'parse-cache.json'),
        JSON.stringify({ version: 99, files: {} }),
        'utf-8',
      );
      const cache = await loadParseCache(wrongVerDir);
      expect(cache.size).toBe(0);
    } finally {
      await fs.rm(wrongVerDir, { recursive: true, force: true });
    }
  });

  // ── End-to-end pipeline test ─────────────────────────────────────────
  // Runs the actual pipeline twice and verifies the graph is complete
  // after an incremental run with unchanged files replayed from cache.

  it('incremental pipeline preserves graph node count after re-index', async () => {
    // First run: full index
    const result1 = await runPipelineFromRepo(tmpRepo, () => {}, { skipGraphPhases: true });
    const nodeCount1 = result1.graph.nodeCount;

    // Sanity: mini-repo should produce some nodes
    expect(nodeCount1).toBeGreaterThan(0);

    // Verify caches were written
    const hashes = await loadFileHashes(storagePath);
    expect(hashes.size).toBeGreaterThan(0);
    const cache = await loadParseCache(storagePath);
    expect(cache.size).toBeGreaterThan(0);

    // Second run: no changes — all files should come from cache
    const result2 = await runPipelineFromRepo(tmpRepo, () => {}, { skipGraphPhases: true });
    const nodeCount2 = result2.graph.nodeCount;

    // Graph must have the same number of nodes
    expect(nodeCount2).toBe(nodeCount1);
  }, 30_000);

  it('incremental pipeline preserves nodes after one file changes', async () => {
    // First run: full index
    const result1 = await runPipelineFromRepo(tmpRepo, () => {}, { skipGraphPhases: true });
    const nodeCount1 = result1.graph.nodeCount;

    // Modify one file
    const targetFile = path.join(tmpRepo, 'src', 'validator.ts');
    const original = await fs.readFile(targetFile, 'utf-8');
    await fs.writeFile(targetFile, original + '\nexport function newValidator() { return true; }\n', 'utf-8');

    try {
      // Second run: one file changed — should re-parse it, replay others
      const result2 = await runPipelineFromRepo(tmpRepo, () => {}, { skipGraphPhases: true });
      const nodeCount2 = result2.graph.nodeCount;

      // Should have at least as many nodes (the new function adds one)
      expect(nodeCount2).toBeGreaterThanOrEqual(nodeCount1);
    } finally {
      await fs.writeFile(targetFile, original, 'utf-8');
    }
  }, 30_000);
});
