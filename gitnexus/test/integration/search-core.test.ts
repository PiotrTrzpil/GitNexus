/**
 * P0 Integration Tests: BM25/FTS Search against real LadybugDB
 *
 * Tests: searchFTSFromLbug via core adapter (no repoId) path against
 * indexed test data. Verifies ranked result ordering, score merging,
 * and empty-match behavior.
 *
 * Uses withTestLbugDB wrapper for full lifecycle management.
 */
import { describe, it, expect } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import { SEARCH_SEED_DATA, SEARCH_FTS_INDEXES } from '../fixtures/search-seed.js';

// ─── Core adapter path (no repoId) ──────────────────────────────────

withTestLbugDB('search-core', (_handle) => {
  describe('searchFTSFromLbug — core adapter (no repoId)', () => {
    it('returns ranked results for a matching query', async () => {
      const output = await searchFTSFromLbug('user authentication', 10);

      expect(output.results.length).toBeGreaterThan(0);
      expect(output.warnings).toHaveLength(0);

      for (const r of output.results) {
        expect(r).toHaveProperty('filePath');
        expect(r).toHaveProperty('score');
        expect(r).toHaveProperty('rank');
        expect(typeof r.filePath).toBe('string');
        expect(typeof r.score).toBe('number');
        expect(typeof r.rank).toBe('number');
        expect(r.score).toBeGreaterThan(0);
      }

      // Ranks should be sequential starting from 1
      output.results.forEach((r, i) => {
        expect(r.rank).toBe(i + 1);
      });
    });

    it('results are ordered by descending score', async () => {
      const output = await searchFTSFromLbug('user authentication', 10);

      for (let i = 1; i < output.results.length; i++) {
        expect(output.results[i - 1].score).toBeGreaterThanOrEqual(output.results[i].score);
      }
    });

    it('auth-related files rank higher than unrelated files', async () => {
      const output = await searchFTSFromLbug('user authentication', 10);
      const filePaths = output.results.map((r) => r.filePath);

      expect(filePaths).toContain('src/auth.ts');

      const authIdx = filePaths.indexOf('src/auth.ts');
      const utilsIdx = filePaths.indexOf('src/utils.ts');
      if (utilsIdx !== -1) {
        expect(authIdx).toBeLessThan(utilsIdx);
      }
    });

    it('merges scores from multiple node types for the same filePath', async () => {
      const output = await searchFTSFromLbug('user authentication', 20);

      const authResult = output.results.find((r) => r.filePath === 'src/auth.ts');
      expect(authResult).toBeDefined();

      const routerResult = output.results.find((r) => r.filePath === 'src/router.ts');
      if (routerResult) {
        expect(authResult!.score).toBeGreaterThan(routerResult.score);
      }
    });

    it('respects limit parameter', async () => {
      const output = await searchFTSFromLbug('user authentication', 2);
      expect(output.results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty results for a non-matching query', async () => {
      const output = await searchFTSFromLbug('xyzzyplughtwisty', 10);
      expect(output.results).toEqual([]);
    });
  });

  // ─── Unhappy paths ──────────────────────────────────────────────────

  describe('unhappy paths', () => {
    it('returns empty results for empty query string', async () => {
      const output = await searchFTSFromLbug('', 10);
      expect(output.results).toEqual([]);
    });

    it('returns empty results for whitespace-only query', async () => {
      const output = await searchFTSFromLbug('   ', 10);
      expect(output.results).toEqual([]);
    });

    it('handles special characters in query gracefully', async () => {
      const output = await searchFTSFromLbug('user* OR auth+', 10);
      expect(Array.isArray(output.results)).toBe(true);
    });

    it('handles limit of 0', async () => {
      const output = await searchFTSFromLbug('user authentication', 0);
      expect(output.results).toEqual([]);
    });

    it('handles negative limit gracefully', async () => {
      const output = await searchFTSFromLbug('user authentication', -1);
      expect(Array.isArray(output.results)).toBe(true);
    });

    it('handles very large limit', async () => {
      const output = await searchFTSFromLbug('user authentication', 100000);
      expect(output.results.length).toBeLessThanOrEqual(100000);
      expect(output.results.length).toBeGreaterThan(0);
    });
  });
}, {
  seed: SEARCH_SEED_DATA,
  ftsIndexes: SEARCH_FTS_INDEXES,
});
