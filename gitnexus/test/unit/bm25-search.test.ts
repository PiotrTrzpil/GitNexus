import { describe, it, expect } from 'vitest';
import { searchFTSFromLbug, type BM25SearchResult } from '../../src/core/search/bm25-index.js';

describe('BM25 search', () => {
  describe('searchFTSFromLbug', () => {
    it('returns empty results with warnings when LadybugDB is not initialized', async () => {
      // Without LadybugDB init, search should return empty results with warnings (not crash)
      const output = await searchFTSFromLbug('test query');
      expect(Array.isArray(output.results)).toBe(true);
      expect(output.results).toHaveLength(0);
      expect(Array.isArray(output.warnings)).toBe(true);
      // Should have warnings since FTS queries fail without init
      expect(output.warnings.length).toBeGreaterThan(0);
    });

    it('handles empty query', async () => {
      const output = await searchFTSFromLbug('');
      expect(Array.isArray(output.results)).toBe(true);
    });

    it('accepts custom limit parameter', async () => {
      const output = await searchFTSFromLbug('test', 5);
      expect(Array.isArray(output.results)).toBe(true);
    });
  });

  describe('BM25SearchResult type', () => {
    it('has correct shape', () => {
      const result: BM25SearchResult = {
        filePath: 'src/index.ts',
        score: 1.5,
        rank: 1,
      };
      expect(result.filePath).toBe('src/index.ts');
      expect(result.score).toBe(1.5);
      expect(result.rank).toBe(1);
    });
  });
});
