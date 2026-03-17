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
import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';

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
});
