/**
 * Parse Cache Storage
 *
 * Persists and loads per-file tree-sitter extraction results so that
 * incremental indexing can replay cached data for unchanged files instead
 * of re-parsing them.  This ensures the in-memory graph is complete even
 * when only a subset of files are re-parsed.
 *
 * Stored as `.gitnexus/parse-cache.json` — compact JSON (no pretty print)
 * since this can be large for big repos.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ExtractedImport,
  ExtractedCall,
  ExtractedHeritage,
  ExtractedRoute,
  FileConstructorBindings,
} from '../core/ingestion/workers/parse-worker.js';

const PARSE_CACHE_FILENAME = 'parse-cache.json';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Cached extraction result for a single file. */
export interface CachedFileResult {
  nodes: CachedNode[];
  relationships: CachedRelationship[];
  symbols: CachedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  constructorBindings: FileConstructorBindings[];
}

/** Mirrors ParsedNode from parse-worker.ts (serializable). */
export interface CachedNode {
  id: string;
  label: string;
  properties: {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    isExported: boolean;
    astFrameworkMultiplier?: number;
    astFrameworkReason?: string;
    description?: string;
    parameterCount?: number;
    returnType?: string;
  };
}

/** Mirrors ParsedRelationship from parse-worker.ts. */
export interface CachedRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'DEFINES' | 'HAS_METHOD';
  confidence: number;
  reason: string;
}

/** Mirrors ParsedSymbol from parse-worker.ts. */
export interface CachedSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: string;
  parameterCount?: number;
  returnType?: string;
  ownerId?: string;
}

/** On-disk format: object keyed by relative file path. */
interface ParseCacheFile {
  version: 1;
  files: Record<string, CachedFileResult>;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Return the absolute path to the parse-cache JSON file. */
export const getParseCachePath = (storagePath: string): string => {
  return path.join(storagePath, PARSE_CACHE_FILENAME);
};

/**
 * Load the parse cache from disk.
 *
 * Returns a Map<relPath, CachedFileResult> for O(1) lookups.
 * Returns an empty Map if the file does not exist or has an incompatible version.
 */
export const loadParseCache = async (
  storagePath: string,
): Promise<Map<string, CachedFileResult>> => {
  const filePath = getParseCachePath(storagePath);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as ParseCacheFile;
    if (!data || data.version !== 1 || typeof data.files !== 'object') {
      return new Map();
    }
    return new Map(Object.entries(data.files));
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return new Map(); // first index — no cache yet
    }
    // Corrupted or unreadable — fall back to empty (full parse)
    return new Map();
  }
};

/**
 * Persist the parse cache to disk.
 *
 * Writes compact JSON (no indentation) since this can be large for big repos.
 */
export const saveParseCache = async (
  storagePath: string,
  cache: Map<string, CachedFileResult>,
): Promise<void> => {
  await fs.mkdir(storagePath, { recursive: true });
  const filePath = getParseCachePath(storagePath);
  const data: ParseCacheFile = {
    version: 1,
    files: Object.fromEntries(cache),
  };
  await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');
};
