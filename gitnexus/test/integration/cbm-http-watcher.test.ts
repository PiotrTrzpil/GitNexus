/**
 * Integration tests for HTTP route discovery and file watcher subsystems.
 *
 * Covers:
 *   - http-similarity: levenshteinDistance, normalizedLevenshtein, ngramOverlap, confidenceBand
 *   - http-linker:     pathMatchScore, matchAndLink (RouteHandler / HTTPLink types)
 *   - file-watcher:    startWatcher — change detection, stop, grace period
 *   - http-patterns:   normalizePath, extractURLPaths
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  levenshteinDistance,
  normalizedLevenshtein,
  ngramOverlap,
  confidenceBand,
} from '../../src/core/ingestion/http-similarity.js';

import {
  pathMatchScore,
  matchAndLink,
  type RouteHandler,
  type HTTPLink,
} from '../../src/core/ingestion/http-linker.js';

import {
  normalizePath,
  extractURLPaths,
} from '../../src/core/ingestion/http-patterns.js';

import { startWatcher } from '../../src/core/watcher/file-watcher.js';

// ─── HTTP Similarity ──────────────────────────────────────────────────────────

describe('levenshteinDistance', { timeout: 5000 }, () => {
  it('returns 3 for kitten → sitting', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
  });

  it('returns the length of b when a is empty', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
  });

  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('same', 'same')).toBe(0);
  });
});

describe('normalizedLevenshtein', { timeout: 5000 }, () => {
  it('returns 1.0 for identical strings', () => {
    expect(normalizedLevenshtein('same', 'same')).toBe(1.0);
  });

  it('returns 1.0 for two empty strings', () => {
    expect(normalizedLevenshtein('', '')).toBe(1.0);
  });

  it('returns a value between 0 and 1 for different strings', () => {
    const score = normalizedLevenshtein('kitten', 'sitting');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe('ngramOverlap', { timeout: 5000 }, () => {
  it('computes bigram overlap coefficient correctly', () => {
    // 'abcde' bigrams: {ab, bc, cd, de} — size 4
    // 'cdefg' bigrams: {cd, de, ef, fg} — size 4
    // intersection: {cd, de} = 2
    // result: 2 / min(4, 4) = 0.5
    expect(ngramOverlap('abcde', 'cdefg', 2)).toBe(0.5);
  });

  it('throws when n <= 0', () => {
    expect(() => ngramOverlap('abc', 'def', 0)).toThrow();
    expect(() => ngramOverlap('abc', 'def', -1)).toThrow();
  });

  it('returns 0 when strings are shorter than n', () => {
    expect(ngramOverlap('ab', 'cd', 5)).toBe(0);
  });
});

describe('confidenceBand', { timeout: 5000 }, () => {
  it('returns "high" for scores >= 0.7', () => {
    expect(confidenceBand(0.7)).toBe('high');
    expect(confidenceBand(0.8)).toBe('high');
    expect(confidenceBand(1.0)).toBe('high');
  });

  it('returns "medium" for scores >= 0.45 and < 0.7', () => {
    expect(confidenceBand(0.45)).toBe('medium');
    expect(confidenceBand(0.5)).toBe('medium');
    expect(confidenceBand(0.69)).toBe('medium');
  });

  it('returns "speculative" for scores >= 0.25 and < 0.45', () => {
    expect(confidenceBand(0.25)).toBe('speculative');
    expect(confidenceBand(0.3)).toBe('speculative');
    expect(confidenceBand(0.44)).toBe('speculative');
  });

  it('returns "" for scores below 0.25', () => {
    expect(confidenceBand(0.1)).toBe('');
    expect(confidenceBand(0.0)).toBe('');
    expect(confidenceBand(0.24)).toBe('');
  });
});

// ─── HTTP Path Matching ───────────────────────────────────────────────────────

describe('pathMatchScore', { timeout: 5000 }, () => {
  it('scores an exact path match close to 0.95 × combined factor', () => {
    // exact → matchBase=0.95, both sides same segments
    const score = pathMatchScore('/api/users', '/api/users');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1.0);
    // With 2 segments, depthFactor = min(2/3, 1) ≈ 0.667, jaccard=1.0
    // score = 0.95 * (0.5*1.0 + 0.5*0.667) ≈ 0.792
    expect(score).toBeGreaterThan(0.7);
  });

  it('scores a suffix match lower than an exact match', () => {
    const exact = pathMatchScore('/api/users', '/api/users');
    const suffix = pathMatchScore('/v2/api/users', '/api/users');
    // suffix path ends with route, matchBase=0.75
    expect(suffix).toBeGreaterThan(0);
    expect(suffix).toBeLessThan(exact);
  });

  it('scores a wildcard segment match above zero', () => {
    // normalizePath converts :id → *, so both normalize to /api/*/profile
    const score = pathMatchScore('/api/*/profile', '/api/:id/profile');
    expect(score).toBeGreaterThan(0);
  });

  it('returns 0 for paths with no matching segments', () => {
    expect(pathMatchScore('/api/users', '/api/products')).toBe(0);
  });

  it('returns 0 for the root path "/" (normalizePath strips trailing slash)', () => {
    // normalizePath('/') → '' which is falsy — guard returns 0
    expect(pathMatchScore('/', '/')).toBe(0);
  });
});

describe('matchAndLink', { timeout: 5000 }, () => {
  it('returns an HTTPLink when a call site matches a route across services', () => {
    const routes: RouteHandler[] = [
      {
        path: '/api/orders',
        method: 'GET',
        functionName: 'listOrders',
        qualifiedName: 'service-b.routes.orders.listOrders',
        protocol: '',
        framework: 'express',
      },
    ];

    // sourceQualifiedName must NOT share the same service directory as route qualifiedName
    // (sameService strips last 2 dot-segments; service-a vs service-b differ)
    const callSites = [
      {
        path: '/api/orders',
        method: 'GET',
        sourceQualifiedName: 'service-a.client.http.fetchOrders',
        sourceName: 'fetchOrders',
        sourceLabel: 'Function' as const,
        isAsync: false,
      },
    ];

    const links: HTTPLink[] = matchAndLink(routes, callSites, { minConfidence: 0.25 });

    expect(links.length).toBeGreaterThan(0);
    expect(links[0].confidence).toBeGreaterThan(0.25);
    expect(links[0].sourceQN).toBe('service-a.client.http.fetchOrders');
    expect(links[0].targetQN).toBe('service-b.routes.orders.listOrders');
  });

  it('emits no links when the only match is within the same service', () => {
    // sameService strips 2 segments and compares prefixes:
    // service-a.routes.items.listItems → "service-a.routes"
    // service-a.routes.api.fetchItems  → "service-a.routes"  (same!)
    const routes: RouteHandler[] = [
      {
        path: '/api/items',
        method: 'GET',
        functionName: 'listItems',
        qualifiedName: 'service-a.routes.items.listItems',
        protocol: '',
        framework: 'express',
      },
    ];

    const callSites = [
      {
        path: '/api/items',
        method: 'GET',
        sourceQualifiedName: 'service-a.routes.api.fetchItems',
        sourceName: 'fetchItems',
        sourceLabel: 'Function' as const,
        isAsync: false,
      },
    ];

    const links = matchAndLink(routes, callSites, { minConfidence: 0.25 });
    expect(links).toHaveLength(0);
  });

  it('filters out links below the configured minConfidence', () => {
    const routes: RouteHandler[] = [
      {
        path: '/api/users',
        method: 'GET',
        functionName: 'getUsers',
        qualifiedName: 'svc-b.handlers.users.getUsers',
        protocol: '',
        framework: 'express',
      },
    ];

    const callSites = [
      {
        path: '/api/users',
        method: 'GET',
        sourceQualifiedName: 'svc-a.client.api.fetchUsers',
        sourceName: 'fetchUsers',
        sourceLabel: 'Function' as const,
        isAsync: false,
      },
    ];

    const highThresholdLinks = matchAndLink(routes, callSites, { minConfidence: 0.99 });
    expect(highThresholdLinks).toHaveLength(0);
  });
});

// ─── HTTP Patterns ────────────────────────────────────────────────────────────

describe('normalizePath', { timeout: 5000 }, () => {
  it('replaces :param segments with *', () => {
    expect(normalizePath('/api/users/:id')).toBe('/api/users/*');
  });

  it('replaces {param} segments with *', () => {
    expect(normalizePath('/api/users/{id}')).toBe('/api/users/*');
  });

  it('replaces UUID segments with *', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const result = normalizePath(`/api/objects/${uuid}/details`);
    expect(result).toBe('/api/objects/*/details');
  });

  it('strips trailing slashes', () => {
    expect(normalizePath('/api/users/')).toBe('/api/users');
  });

  it('lowercases the path', () => {
    expect(normalizePath('/API/Users')).toBe('/api/users');
  });
});

describe('extractURLPaths', { timeout: 5000 }, () => {
  it('extracts quoted path literals with two or more segments', () => {
    const text = `const url = "/api/users";`;
    const paths = extractURLPaths(text);
    expect(paths).toContain('/api/users');
  });

  it('extracts the path component from a full HTTP URL', () => {
    const text = `fetch("http://internal-service/api/orders/list")`;
    const paths = extractURLPaths(text);
    expect(paths.some(p => p.includes('/api/orders'))).toBe(true);
  });

  it('skips external domain URLs', () => {
    const text = `const url = "https://github.com/org/repo";`;
    const paths = extractURLPaths(text);
    expect(paths).toHaveLength(0);
  });

  it('deduplicates repeated path occurrences', () => {
    const text = `"/api/users" + "/api/users"`;
    const paths = extractURLPaths(text);
    expect(paths.filter(p => p === '/api/users')).toHaveLength(1);
  });
});

// ─── File Watcher ─────────────────────────────────────────────────────────────

describe('file-watcher', () => {
  let tmpDir: string;
  let stopWatcher: (() => void) | null = null;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-watcher-test-'));
    await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export const a = 1;');
  });

  afterAll(async () => {
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  afterEach(() => {
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
  });

  it(
    'calls onReindex after a file change following the grace period and first-poll baseline',
    async () => {
      const onReindex = vi.fn().mockResolvedValue(undefined);

      stopWatcher = startWatcher(
        [{ path: tmpDir, fileCount: 1 }],
        {
          onReindex,
          gracePeriodMs: 100,   // 100ms grace before polling starts
          maxIntervalMs: 2000,  // cap interval at 2s for this test
        },
      );

      // Wait for grace period + first tick + baseline snapshot to complete.
      // Grace=100ms, first tick at ~1100ms, snapshot capture takes time.
      // Wait 1800ms to be safe, then mutate.
      await new Promise(r => setTimeout(r, 1800));

      // Mutate a file so the next snapshot differs from the baseline
      await fs.writeFile(path.join(tmpDir, 'index.ts'), `export const a = ${Date.now()};`);

      // Wait for the next poll cycle to detect the change.
      // Interval is 1000ms, plus snapshot overhead.
      await new Promise(r => setTimeout(r, 2000));

      expect(onReindex).toHaveBeenCalledWith(tmpDir);
    },
    30000,
  );

  it(
    'stops polling after stopWatcher() is called — no further onReindex invocations',
    async () => {
      const onReindex = vi.fn().mockResolvedValue(undefined);

      const stop = startWatcher(
        [{ path: tmpDir, fileCount: 1 }],
        {
          onReindex,
          gracePeriodMs: 100,
          maxIntervalMs: 2000,
        },
      );

      // Let grace period pass and first poll fire
      await new Promise(r => setTimeout(r, 300));

      // Halt the watcher immediately
      stop();
      stopWatcher = null; // afterEach won't double-call

      const callCountAtStop = onReindex.mock.calls.length;

      // Modify the file — should NOT trigger onReindex since watcher is stopped
      await fs.writeFile(path.join(tmpDir, 'stopped.ts'), `// ${Date.now()}`);

      // Wait a full poll cycle
      await new Promise(r => setTimeout(r, 1500));

      expect(onReindex.mock.calls.length).toBe(callCountAtStop);
    },
    30000,
  );

  it(
    'does not fire onReindex during the grace period',
    async () => {
      const onReindex = vi.fn().mockResolvedValue(undefined);

      stopWatcher = startWatcher(
        [{ path: tmpDir, fileCount: 1 }],
        {
          onReindex,
          gracePeriodMs: 500,   // 500ms grace
          maxIntervalMs: 2000,
        },
      );

      // Modify a file immediately — watcher is still in grace period
      await fs.writeFile(path.join(tmpDir, 'grace.ts'), `// ${Date.now()}`);

      // Wait only within the grace window
      await new Promise(r => setTimeout(r, 200));

      // onReindex must not have been called yet — polling hasn't started
      expect(onReindex).not.toHaveBeenCalled();
    },
    30000,
  );
});
