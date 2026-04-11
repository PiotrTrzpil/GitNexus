/**
 * P0 Integration Tests: BM25/FTS Search against real LadybugDB
 *
 * Tests: searchFTSFromLbug via MCP pool adapter (with repoId) path
 * against indexed test data. Verifies ranked result ordering and
 * empty-match behavior through the pool adapter.
 *
 * Uses withTestLbugDB wrapper for full lifecycle management.
 */
import { describe, it, expect } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import { SEARCH_SEED_DATA, SEARCH_FTS_INDEXES } from '../fixtures/search-seed.js';

// ─── MCP pool adapter path (with repoId) ────────────────────────────

withTestLbugDB('search-pool', (handle) => {
  describe('searchFTSFromLbug — MCP pool adapter (with repoId)', () => {
    it('returns ranked results via pool adapter', async () => {
      const output = await searchFTSFromLbug('user authentication', 10, handle.repoId);

      expect(output.results.length).toBeGreaterThan(0);
      expect(output.warnings).toHaveLength(0);

      for (const r of output.results) {
        expect(r).toHaveProperty('filePath');
        expect(r).toHaveProperty('score');
        expect(r).toHaveProperty('rank');
        expect(r.score).toBeGreaterThan(0);
      }

      const filePaths = output.results.map((r) => r.filePath);
      expect(filePaths).toContain('src/auth.ts');
    });

    it('results are ordered by descending score via pool adapter', async () => {
      const output = await searchFTSFromLbug('user authentication', 10, handle.repoId);

      for (let i = 1; i < output.results.length; i++) {
        expect(output.results[i - 1].score).toBeGreaterThanOrEqual(output.results[i].score);
      }
    });

    it('returns empty results for non-matching query via pool adapter', async () => {
      const output = await searchFTSFromLbug('xyzzyplughtwisty', 10, handle.repoId);
      expect(output.results).toEqual([]);
    });

    it('respects limit parameter via pool adapter', async () => {
      const output = await searchFTSFromLbug('user authentication', 1, handle.repoId);
      expect(output.results.length).toBeLessThanOrEqual(1);
    });
  });

  // ─── Unhappy paths ──────────────────────────────────────────────────

  describe('unhappy paths', () => {
    it('returns empty results for empty query via pool', async () => {
      const output = await searchFTSFromLbug('', 10, handle.repoId);
      expect(output.results).toEqual([]);
    });

    it('returns empty results for whitespace-only query via pool', async () => {
      const output = await searchFTSFromLbug('   ', 10, handle.repoId);
      expect(output.results).toEqual([]);
    });

    it('handles special characters in query via pool', async () => {
      const output = await searchFTSFromLbug('user* OR auth+', 10, handle.repoId);
      expect(Array.isArray(output.results)).toBe(true);
    });

    it('handles limit of 0 via pool', async () => {
      const output = await searchFTSFromLbug('user authentication', 0, handle.repoId);
      expect(output.results).toEqual([]);
    });
  });
}, {
  seed: SEARCH_SEED_DATA,
  ftsIndexes: SEARCH_FTS_INDEXES,
  poolAdapter: true,
});
