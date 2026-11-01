/**
 * "Files that usually change together", end to end on a real git repository:
 * the `coChange` phase writes CO_CHANGES_WITH edges, a second (incremental)
 * analyze keeps exactly one copy of them, and `impact` / `detect_changes`
 * surface them.
 *
 * History built below (spec, not captured output):
 *   commit 1  adds api.ts, client.ts, util.ts, lonely.ts          (4 files)
 *   commits 2-5  edit api.ts + client.ts together                  (4 commits)
 *   commit 6  edits util.ts alone
 *   commit 7  edits only lockfile-like noise.json + api.ts         (api.ts again)
 * => api.ts changes 6 times, client.ts 5 times, together 5 times:
 *    strength 5 / min(6, 5) = 1. util.ts and lonely.ts share only commit 1
 *    with api.ts (support 1 < 3) so they get no edge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { executeQuery, closeLbug, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { createTempDir } from '../helpers/test-db.js';

const isWin = process.platform === 'win32';

describe.skipIf(isWin)('co-change edges and their surfacing', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let repo: string;
  let savedHome: string | undefined;

  const write = (file: string, body: string): Promise<void> =>
    fs.writeFile(path.join(repo, file), body);
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
        onProgress: (_p: string, _n: number, message?: string) => {
          if (message?.startsWith('Removing rows for changed files')) incremental = true;
        },
      },
    );
    return { incremental };
  };
  const coEdges = async (): Promise<Array<{ a: string; b: string; strength: number; count: number }>> => {
    await initLbug(getStoragePaths(repo).lbugPath);
    try {
      const rows = await executeQuery(
        `MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE r.type = 'CO_CHANGES_WITH'
         RETURN a.filePath AS src, b.filePath AS dst, r.confidence AS strength, r.step AS count
         ORDER BY src, dst`,
      );
      return rows.map((r) => ({
        a: String(r.src),
        b: String(r.dst),
        strength: Number(r.strength),
        count: Number(r.count),
      }));
    } finally {
      await closeLbug();
    }
  };

  beforeAll(async () => {
    tmpHome = await createTempDir('gn-cochange-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    tmpRepo = await createTempDir('gn-cochange-repo-');
    repo = tmpRepo.dbPath;
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
    await write('api.ts', 'export function route() { return 0; }\n');
    await write('client.ts', 'export function call() { return 0; }\n');
    await write('util.ts', 'export function util() { return 0; }\n');
    await write('lonely.ts', 'export function lonely() { return 0; }\n');
    commit('init');
    for (let i = 1; i <= 4; i++) {
      await write('api.ts', `export function route() { return ${i}; }\n`);
      await write('client.ts', `export function call() { return ${i}; }\n`);
      commit(`api+client ${i}`);
    }
    await write('util.ts', 'export function util() { return 1; }\n');
    commit('util alone');
    await write('api.ts', 'export function route() { return 99; }\n');
    commit('api alone');
  }, 60_000);

  afterAll(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo?.cleanup();
    await tmpHome?.cleanup();
  });

  it('writes one CO_CHANGES_WITH edge for the pair that changed together', async () => {
    await analyze();
    expect(await coEdges()).toEqual([{ a: 'api.ts', b: 'client.ts', strength: 1, count: 5 }]);
  }, 180_000);

  it('keeps exactly one copy of the edge across an incremental re-analyze', async () => {
    await write('util.ts', 'export function util() { return 2; }\n');
    commit('util alone again');
    const { incremental } = await analyze();
    expect(incremental).toBe(true);
    expect(await coEdges()).toEqual([{ a: 'api.ts', b: 'client.ts', strength: 1, count: 5 }]);
  }, 180_000);

  describe('tools', () => {
    let backend: LocalBackend;
    beforeAll(async () => {
      backend = new LocalBackend();
      await backend.init();
    });
    afterAll(async () => {
      await backend?.disconnect?.();
    });

    it('impact lists the target file\'s co-changed partner', async () => {
      const result: any = await backend.callTool('impact', {
        repo: path.basename(repo),
        target: 'route',
        direction: 'upstream',
      });
      expect(result.error).toBeUndefined();
      expect(result.co_changed).toEqual([{ file: 'client.ts', strength: 1, count: 5 }]);
    }, 60_000);

    it('detect_changes names the partner that is not in the diff, and omits it when it is', async () => {
      await write('api.ts', 'export function route() { return 100; }\n');
      const alone: any = await backend.callTool('detect_changes', {
        repo: path.basename(repo),
        scope: 'unstaged',
      });
      expect(alone.co_changed_not_in_diff).toEqual([
        { file: 'client.ts', strength: 1, count: 5, with: ['api.ts'] },
      ]);

      await write('client.ts', 'export function call() { return 100; }\n');
      const both: any = await backend.callTool('detect_changes', {
        repo: path.basename(repo),
        scope: 'unstaged',
      });
      expect(both.co_changed_not_in_diff).toBeUndefined();
    }, 60_000);
  });
});
