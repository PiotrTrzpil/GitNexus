import { describe, expect, it } from 'vitest';
import {
  computeCoChangePairs,
  parseGitLog,
  CO_CHANGE_MAX_FILES_PER_COMMIT,
} from '../../src/core/ingestion/co-change.js';
import { partnersMissingFromDiff } from '../../src/mcp/local/co-change-query.js';

const all = () => true;
const repeat = <T>(n: number, item: T): T[] => Array.from({ length: n }, () => item);

describe('parseGitLog', () => {
  it('splits commits on the separator and drops blank lines', () => {
    const out = '\u0001\na.ts\nb.ts\n\n\u0001\nc.ts\n\n\u0001\n';
    expect(parseGitLog(out)).toEqual([['a.ts', 'b.ts'], ['c.ts']]);
  });
});

describe('computeCoChangePairs', () => {
  it('requires a minimum support of 3 co-changes', () => {
    const two = repeat(2, ['api.py', 'client.ts']);
    expect(computeCoChangePairs(two, all)).toEqual([]);
    const three = repeat(3, ['api.py', 'client.ts']);
    expect(computeCoChangePairs(three, all)).toEqual([
      { fileA: 'api.py', fileB: 'client.ts', count: 3, strength: 1 },
    ]);
  });

  it('scores strength as co-changes over the less-active file\'s changes', () => {
    // a: 10 changes, b: 4 changes, together 4 -> 4 / min(10, 4) = 1
    // a: 10 changes, c: 5 changes, together 3 -> 3 / 5 = 0.6
    const commits = [
      ...repeat(4, ['a.ts', 'b.ts']),
      ...repeat(3, ['a.ts', 'c.ts']),
      ...repeat(3, ['a.ts']),
      ...repeat(2, ['c.ts']),
    ];
    const pairs = computeCoChangePairs(commits, all);
    expect(pairs).toEqual([
      { fileA: 'a.ts', fileB: 'b.ts', count: 4, strength: 1 },
      { fileA: 'a.ts', fileB: 'c.ts', count: 3, strength: 0.6 },
    ]);
  });

  it('drops pairs below the minimum strength of 0.3', () => {
    // together 3, but b changes 20 times and a 20 times: 3/20 = 0.15
    const commits = [
      ...repeat(3, ['a.ts', 'b.ts']),
      ...repeat(17, ['a.ts']),
      ...repeat(17, ['b.ts']),
    ];
    expect(computeCoChangePairs(commits, all)).toEqual([]);
  });

  it('skips commits touching more than the per-commit file limit', () => {
    const big = Array.from({ length: CO_CHANGE_MAX_FILES_PER_COMMIT + 1 }, (_, i) => `f${i}.ts`);
    expect(computeCoChangePairs(repeat(5, big), all)).toEqual([]);
    expect(
      computeCoChangePairs(repeat(3, ['a.ts', 'b.ts', 'c.ts', 'd.ts']), all, {
        maxFilesPerCommit: 3,
      }),
    ).toEqual([]);
    expect(
      computeCoChangePairs(repeat(3, ['a.ts', 'b.ts', 'c.ts']), all, { maxFilesPerCommit: 3 }),
    ).toHaveLength(3);
  });

  it('ignores files that are not indexed, and counts commit size before filtering', () => {
    const commits = repeat(3, ['a.ts', 'b.ts', 'package-lock.json']);
    const pairs = computeCoChangePairs(commits, (f) => f !== 'package-lock.json');
    expect(pairs).toEqual([{ fileA: 'a.ts', fileB: 'b.ts', count: 3, strength: 1 }]);
  });

  it('keeps a hub\'s edge to a leaf even beyond the hub\'s top-N (leaf slot is free)', () => {
    const commits: string[][] = [];
    ['p1.ts', 'p2.ts', 'p3.ts'].forEach((p, i) => {
      commits.push(...repeat(10 - i, ['hub.ts', p]), ...repeat(i, [p]));
    });
    const kept = computeCoChangePairs(commits, all, { topPartners: 1 });
    expect(kept.map((p) => p.fileB).sort()).toEqual(['p1.ts', 'p2.ts', 'p3.ts']);
  });

  it('ranks by shared commits before strength', () => {
    // router~page: 5 together, page changes 9 -> strength 5/8 = 0.625
    // router~schema: 3 together, schema only ever changes with router -> strength 1
    const commits = [
      ...repeat(5, ['router.py', 'page.tsx']),
      ...repeat(4, ['page.tsx']),
      ...repeat(3, ['router.py', 'schema.py']),
    ];
    expect(computeCoChangePairs(commits, all).map((p) => `${p.fileA}~${p.fileB}`)).toEqual([
      'page.tsx~router.py',
      'router.py~schema.py',
    ]);
  });

  it('drops an edge when both endpoints already hold their top-N partners', () => {
    // Changes: a=9, b=8, c=7. Strengths: ab 5/8, ac 4/7, bc 3/7.
    const commits = [
      ...repeat(5, ['a.ts', 'b.ts']),
      ...repeat(4, ['a.ts', 'c.ts']),
      ...repeat(3, ['b.ts', 'c.ts']),
    ];
    const kept = computeCoChangePairs(commits, all, { topPartners: 1, minStrength: 0.1 });
    expect(kept.map((p) => `${p.fileA}~${p.fileB}`)).toEqual(['a.ts~b.ts', 'a.ts~c.ts']);
  });
});

describe('partnersMissingFromDiff', () => {
  it('lists partners absent from the diff with the files they go with', () => {
    const byFile = new Map([
      [
        'api.py',
        [
          { file: 'client.ts', strength: 0.9, count: 9 },
          { file: 'schema.sql', strength: 0.5, count: 5 },
          { file: 'tests/api_test.py', strength: 0.7, count: 7 },
        ],
      ],
      ['models.py', [{ file: 'schema.sql', strength: 0.6, count: 6 }]],
    ]);
    const out = partnersMissingFromDiff(byFile, new Set(['api.py', 'models.py', 'client.ts']));
    expect(out).toEqual([
      { file: 'tests/api_test.py', strength: 0.7, count: 7, with: ['api.py'] },
      { file: 'schema.sql', strength: 0.6, count: 6, with: ['api.py', 'models.py'] },
    ]);
  });

  it('orders by shared commits before strength and keeps the busier pairing', () => {
    const byFile = new Map([
      ['router.py', [{ file: 'schema.py', strength: 1, count: 3 }, { file: 'page.tsx', strength: 0.56, count: 5 }]],
      ['api.py', [{ file: 'schema.py', strength: 0.4, count: 6 }]],
    ]);
    const out = partnersMissingFromDiff(byFile, new Set(['router.py', 'api.py']));
    expect(out).toEqual([
      { file: 'schema.py', strength: 0.4, count: 6, with: ['api.py', 'router.py'] },
      { file: 'page.tsx', strength: 0.56, count: 5, with: ['router.py'] },
    ]);
  });

  it('caps the list', () => {
    const partners = Array.from({ length: 8 }, (_, i) => ({
      file: `x${i}.ts`,
      strength: 0.9 - i * 0.05,
      count: 5,
    }));
    const out = partnersMissingFromDiff(new Map([['a.ts', partners]]), new Set(['a.ts']), 3);
    expect(out.map((p) => p.file)).toEqual(['x0.ts', 'x1.ts', 'x2.ts']);
  });
});
