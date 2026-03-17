/**
 * Incremental Indexing
 *
 * Ported from codebase-memory-mcp/internal/pipeline/pipeline.go:
 *   classifyFiles(), fileHash(), findDependentFiles()
 *
 * Key decisions:
 *  - xxhash-wasm (pure WASM, no native compilation) for content hashing
 *  - Parallelized via Promise.all with a concurrency cap (I/O-bound, not CPU)
 *  - Dependent-file discovery uses the importMap from ResolutionContext
 *    (Map<filePath, Set<resolvedFilePath>>), which is cheaper than re-parsing
 *  - First index (no stored hashes) → all files classified as changed
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import xxhashFactory, { type XXHashAPI } from 'xxhash-wasm';
import type { ScannedFile } from './filesystem-walker.js';
import type { ImportMap } from './resolution-context.js';

// ─── Exported Types (Shared Contracts) ────────────────────────────────────────

/** Content-hash fingerprint for one file. */
export interface FileHash {
  relPath: string;
  hash: string;    // xxHash64 hex string
}

/**
 * Result of classifying a set of scanned files against stored hashes.
 *
 *  - `changed`   — files whose hash differs from the stored value (re-parse)
 *  - `unchanged` — files whose hash matches the stored value (may skip)
 *  - `dependent` — unchanged files that import a changed module (re-resolve)
 */
export interface FileClassification {
  changed: string[];     // paths to re-parse
  unchanged: string[];   // paths to skip
  dependent: string[];   // unchanged files that import changed modules
}

// ─── Concurrency ───────────────────────────────────────────────────────────────

/** Max parallel file-read + hash operations.  I/O-bound so CPUs aren't the
 *  bottleneck; keep this moderate to avoid exhausting file descriptors. */
const HASH_CONCURRENCY = 32;

// ─── xxhash singleton ──────────────────────────────────────────────────────────

let xxhashPromise: Promise<XXHashAPI> | null = null;

const getXxhash = (): Promise<XXHashAPI> => {
  if (!xxhashPromise) {
    xxhashPromise = xxhashFactory();
  }
  return xxhashPromise;
};

// ─── Core: hash one file ───────────────────────────────────────────────────────

/**
 * Compute the xxHash64 content fingerprint of a file.
 * Returns a 16-character lowercase hex string.
 * Throws if the file cannot be read.
 */
export const computeFileHash = async (absolutePath: string): Promise<string> => {
  const xxhash = await getXxhash();
  const buf = await fs.readFile(absolutePath);
  const hashBigInt = xxhash.h64Raw(buf);
  return hashBigInt.toString(16).padStart(16, '0');
};

// ─── Classify files ────────────────────────────────────────────────────────────

/**
 * Classify scanned repository files as changed or unchanged by comparing their
 * content hashes against `storedHashes`.
 *
 * `storedHashes` is a Map<relPath, hash> loaded from `.gitnexus/file-hashes.json`.
 * Pass an empty Map to force a full index (first run).
 *
 * Hashing is parallelized with a concurrency cap of HASH_CONCURRENCY.
 *
 * Returns `{ changedPaths, unchangedPaths, currentHashes }` so the caller can
 * persist `currentHashes` after a successful index.
 */
export const classifyFiles = async (
  repoPath: string,
  scannedFiles: ScannedFile[],
  storedHashes: Map<string, string>,
): Promise<{
  changedPaths: string[];
  unchangedPaths: string[];
  currentHashes: FileHash[];
}> => {
  if (storedHashes.size === 0) {
    // First index — treat all files as changed, but compute hashes so we can
    // save them at the end.
    const currentHashes = await computeHashesParallel(repoPath, scannedFiles);
    const changedPaths = scannedFiles.map(f => f.path);
    return { changedPaths, unchangedPaths: [], currentHashes };
  }

  const currentHashes = await computeHashesParallel(repoPath, scannedFiles);

  const changedPaths: string[] = [];
  const unchangedPaths: string[] = [];

  for (let i = 0; i < scannedFiles.length; i++) {
    const file = scannedFiles[i];
    const record = currentHashes[i];

    if (record.hash === '' || record.hash === 'error') {
      // Could not read/hash — treat as changed to be safe
      changedPaths.push(file.path);
      continue;
    }

    const relPath = toRelPath(repoPath, file.path);
    const stored = storedHashes.get(relPath);

    if (stored === record.hash) {
      unchangedPaths.push(file.path);
    } else {
      changedPaths.push(file.path);
    }
  }

  return { changedPaths, unchangedPaths, currentHashes };
};

/**
 * High-level entry point: classify files and also discover dependent files.
 *
 * NOTE: Not yet wired into pipeline.ts — requires persisting the importMap
 * between runs so that dependent-file discovery works on re-index.
 * Currently exported for future use and testing.
 *
 * @param repoPath      Absolute path to the repository root
 * @param scannedFiles  Output of walkRepositoryPaths()
 * @param storedHashes  Previously persisted hashes (empty = first index)
 * @param importMap     importMap from ResolutionContext (populated on re-index)
 * @returns FileClassification + currentHashes (for saving after success)
 */
export const classifyAndFindDependents = async (
  repoPath: string,
  scannedFiles: ScannedFile[],
  storedHashes: Map<string, string>,
  importMap: ImportMap,
): Promise<{
  classification: FileClassification;
  currentHashes: FileHash[];
}> => {
  const { changedPaths, unchangedPaths, currentHashes } =
    await classifyFiles(repoPath, scannedFiles, storedHashes);

  const dependentPaths = findDependentFiles(changedPaths, unchangedPaths, importMap);

  return {
    classification: {
      changed: changedPaths,
      unchanged: unchangedPaths,
      dependent: dependentPaths,
    },
    currentHashes,
  };
};

// ─── Dependent-file discovery ─────────────────────────────────────────────────

/**
 * Find unchanged files that import at least one changed module.
 *
 * Ported 1:1 from pipeline.go `findDependentFiles()`.
 *
 * Uses the `importMap` from ResolutionContext: `Map<filePath, Set<resolvedFilePath>>`.
 * An "unchanged" file is a dependent if its import set intersects the changed
 * file set — it must be re-resolved even though its own content did not change.
 *
 * @param changedPaths   Absolute paths to changed files
 * @param unchangedPaths Absolute paths to unchanged files
 * @param importMap      importMap from ResolutionContext (may be empty on first index)
 */
export const findDependentFiles = (
  changedPaths: string[],
  unchangedPaths: string[],
  importMap: ImportMap,
): string[] => {
  if (changedPaths.length === 0 || unchangedPaths.length === 0) {
    return [];
  }

  const changedSet = new Set(changedPaths);
  const dependents: string[] = [];

  for (const filePath of unchangedPaths) {
    const imports = importMap.get(filePath);
    if (!imports) continue;

    for (const importedFile of imports) {
      if (changedSet.has(importedFile)) {
        dependents.push(filePath);
        break;
      }
    }
  }

  return dependents;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute hashes for all files in parallel with a concurrency cap.
 * Returns a `FileHash[]` in the same order as `scannedFiles`.
 * On error for an individual file, the hash field is set to 'error'.
 */
const computeHashesParallel = async (
  repoPath: string,
  scannedFiles: ScannedFile[],
): Promise<FileHash[]> => {
  const results: FileHash[] = new Array(scannedFiles.length);
  let index = 0;

  const runBatch = async (batch: { file: ScannedFile; idx: number }[]): Promise<void> => {
    await Promise.all(
      batch.map(async ({ file, idx }) => {
        const relPath = toRelPath(repoPath, file.path);
        const absolutePath = path.isAbsolute(file.path)
          ? file.path
          : path.join(repoPath, file.path);
        try {
          const hash = await computeFileHash(absolutePath);
          results[idx] = { relPath, hash };
        } catch (err) {
          console.warn(`incremental: failed to hash ${absolutePath}: ${(err as Error).message}`);
          results[idx] = { relPath, hash: 'error' };
        }
      }),
    );
  };

  while (index < scannedFiles.length) {
    const batch = scannedFiles
      .slice(index, index + HASH_CONCURRENCY)
      .map((file, offset) => ({ file, idx: index + offset }));
    await runBatch(batch);
    index += HASH_CONCURRENCY;
  }

  return results;
};

/**
 * Convert an absolute file path to a repo-relative path using forward slashes.
 * If the path does not start with repoPath, returns the path as-is.
 */
const toRelPath = (repoPath: string, absolutePath: string): string => {
  const normalRepo = repoPath.replace(/\\/g, '/').replace(/\/$/, '');
  const normalAbs = absolutePath.replace(/\\/g, '/');
  if (normalAbs.startsWith(normalRepo + '/')) {
    return normalAbs.slice(normalRepo.length + 1);
  }
  return normalAbs;
};
