/**
 * complexity / sloc survive the SECOND, incremental analyze: a changed file's
 * rows are rewritten with the new values, an untouched file keeps its own, and
 * an added file gets values too. Drives the real `runFullAnalysis` over a git
 * repository (pattern: spring-destinations-incremental.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { executeQuery, closeLbug, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const isWin = process.platform === 'win32';

const A_V1 = `export function alpha(a: boolean) {\n  return a ? 1 : 2;\n}\n`; // cx 2, sloc 3
const A_V2 = `export function alpha(a: boolean, b: boolean) {\n  if (a && b) { return 1; }\n  return a ? 1 : 2;\n}\n`; // cx 4, sloc 4
const B = `export function beta(xs: number[]) {\n  for (const x of xs) { if (x) { return x; } }\n  return 0;\n}\n`; // cx 3, sloc 4
const C = `export function gamma(a: boolean) {\n  while (a) { a = false; }\n}\n`; // cx 2, sloc 3

describe.skipIf(isWin)('complexity across an incremental analyze', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let repo: string;
  let savedHome: string | undefined;

  const commit = (message: string): void => {
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message],
      { cwd: repo, stdio: 'pipe' },
    );
  };

  const analyze = async (): Promise<{ incremental: boolean }> => {
    let incremental = false;
    await runFullAnalysis(
      repo,
      {},
      {
        onProgress: (_phase: string, _pct: number, message?: string) => {
          if (message?.startsWith('Removing rows for changed files')) incremental = true;
        },
      },
    );
    return { incremental };
  };

  const metrics = async (): Promise<Record<string, string>> => {
    await initLbug(getStoragePaths(repo).lbugPath);
    try {
      const rows = await executeQuery(
        'MATCH (n:Function) RETURN n.name AS name, n.complexity AS cx, n.sloc AS sloc ORDER BY name',
      );
      return Object.fromEntries(rows.map((r) => [String(r.name), `cx=${r.cx} sloc=${r.sloc}`]));
    } finally {
      await closeLbug();
    }
  };

  beforeAll(async () => {
    tmpHome = await createTempDir('gn-cx-incr-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    tmpRepo = await createTempDir('gn-cx-incr-repo-');
    repo = tmpRepo.dbPath;
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
    await fs.writeFile(path.join(repo, 'a.ts'), A_V1);
    await fs.writeFile(path.join(repo, 'b.ts'), B);
    commit('init');
  }, 60_000);

  afterAll(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo?.cleanup();
    await tmpHome?.cleanup();
  });

  it('stores complexity and sloc on the from-scratch run', async () => {
    await analyze();
    expect(await metrics()).toEqual({
      alpha: 'cx=2 sloc=3',
      beta: 'cx=3 sloc=4',
    });
  }, 180_000);

  it('rewrites the changed file, keeps the untouched one and indexes the added one', async () => {
    await fs.writeFile(path.join(repo, 'a.ts'), A_V2);
    await fs.writeFile(path.join(repo, 'c.ts'), C);
    commit('edit-a-add-c');

    const { incremental } = await analyze();
    expect(incremental).toBe(true);
    expect(await metrics()).toEqual({
      alpha: 'cx=4 sloc=4',
      beta: 'cx=3 sloc=4',
      gamma: 'cx=2 sloc=3',
    });
  }, 180_000);
});
