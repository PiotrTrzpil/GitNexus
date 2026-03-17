/**
 * File Hashes Storage
 *
 * Persists and loads per-file xxHash fingerprints to/from
 * `.gitnexus/file-hashes.json`.  Intentionally stored as a plain JSON file
 * rather than in LadybugDB so that hash records survive a full DB rebuild and
 * never require schema changes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileHash } from '../core/ingestion/incremental.js';

const FILE_HASHES_FILENAME = 'file-hashes.json';

/**
 * Return the absolute path to the file-hashes JSON file for a given storage
 * directory (i.e. the `.gitnexus/` folder of a repository).
 */
export const getFileHashesPath = (storagePath: string): string => {
  return path.join(storagePath, FILE_HASHES_FILENAME);
};

/**
 * Load stored file hashes from disk.
 *
 * Returns a Map<relPath, hash> for O(1) look-ups during classification.
 * Returns an empty Map if the file does not exist yet (first index).
 */
export const loadFileHashes = async (storagePath: string): Promise<Map<string, string>> => {
  const filePath = getFileHashesPath(storagePath);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const records = JSON.parse(raw) as FileHash[];
    if (!Array.isArray(records)) {
      console.warn(`file-hashes.ts: unexpected format in ${filePath} — treating as empty`);
      return new Map();
    }
    const map = new Map<string, string>();
    for (const { relPath, hash } of records) {
      map.set(relPath, hash);
    }
    return map;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return new Map(); // first index — no stored hashes yet
    }
    throw new Error(`Failed to load file hashes from ${filePath}: ${err?.message}`, { cause: err });
  }
};

/**
 * Persist file hashes to disk.
 *
 * Writes an array of `FileHash` records as JSON.  The caller provides fresh
 * hashes after a successful index run so that the next run can skip unchanged
 * files.
 */
export const saveFileHashes = async (storagePath: string, hashes: FileHash[]): Promise<void> => {
  await fs.mkdir(storagePath, { recursive: true });
  const filePath = getFileHashesPath(storagePath);
  await fs.writeFile(filePath, JSON.stringify(hashes), 'utf-8');
};
