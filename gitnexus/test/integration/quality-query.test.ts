/**
 * quality_query end to end: a small TS + Python + Java fixture goes through the
 * real pipeline (parse workers -> graph -> CSV -> COPY into LadybugDB) and every
 * preset is asserted against symbols named by the fixture itself.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, describe, beforeAll } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { runQualityQuery, type QualityExecutor } from '../../src/mcp/local/quality-query.js';

/** 8 distinct helpers, 12 decision points, > 50 lines: satisfies every god_functions threshold. */
const godFunction = (): string => {
  const helpers = Array.from({ length: 8 }, (_, i) => `function step${i}(n: number) { return n + ${i}; }`);
  const body = Array.from({ length: 8 }, (_, i) => `  if (n > ${i}) { total += step${i}(n); }`);
  const loops = ['  for (let i = 0; i < n; i++) { if (i % 2 && total) { total++; } }'];
  const padding = Array.from({ length: 40 }, (_, i) => `  total += ${i};`);
  return [
    ...helpers,
    'function godFunction(n: number) {',
    '  let total = 0;',
    ...body, // 8 ifs
    ...loops, // for + if + && = 3
    ...padding,
    '  return n > 100 ? total : -total;', // ternary = 1
    '}',
  ].join('\n');
};

const LIB_TS = `${godFunction()}

// branchy: if (+1), && (+1), for-of (+1), inner if (+1) => cx 5
function branchy(a: boolean, b: boolean, xs: number[]) {
  if (a && b) { return 1; }
  for (const x of xs) { if (x) { return x; } }
  return 0;
}

function hub() { return 1; }
function viaA() { return hub(); }
function viaB() { return hub(); }
function viaC() { return hub(); }
function deadOne() { return 2; }

export function entry(n: number) {
  viaA(); viaB(); viaC();
  branchy(true, false, []);
  return godFunction(n);
}
export function exportedUnused() { return 3; }
`;

const LIB_TEST_TS = `function unusedInTest() { return 1; }\n`;

const SVC_PY = `def classify(n, flag):
    if n < 0:
        return "neg"
    elif n == 0 and flag:
        return "zero"
    for i in range(n):
        pass
    return "pos"


def unused_py():
    return 1
`;

const IFOO = `package com.q;\npublic interface IFoo { void run(); }\n`;
const FOO = `package com.q;\npublic class FooA implements IFoo { public void run() {} }\n`;
const IDLE = `package com.q;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
public class IdleConsumer {
  @Autowired private List<IFoo> foos;
  public void other() {}
}
`;
const BUSY = `package com.q;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
public class BusyConsumer {
  @Autowired private List<IFoo> foos;
  public void go(IFoo f) { f.run(); }
}
`;

withTestLbugDB('quality-query', (handle) => {
  let run: QualityExecutor;

  beforeAll(async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const root = path.join(handle.tmpHandle.dbPath, 'quality-repo');
    const repoDir = path.join(root, 'repo');
    const storageDir = path.join(root, 'storage');
    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'java'), { recursive: true });
    await fs.mkdir(storageDir, { recursive: true });
    const files: Record<string, string> = {
      'src/lib.ts': LIB_TS,
      'src/lib.test.ts': LIB_TEST_TS,
      'src/svc.py': SVC_PY,
      'java/IFoo.java': IFOO,
      'java/FooA.java': FOO,
      'java/IdleConsumer.java': IDLE,
      'java/BusyConsumer.java': BUSY,
    };
    for (const [rel, text] of Object.entries(files)) {
      await fs.writeFile(path.join(repoDir, rel), text);
    }
    const { graph } = await runPipelineFromRepo(repoDir, () => {}, {});
    await adapter.loadGraphToLbug(graph, repoDir, storageDir);
    run = (cypher, params) => adapter.executePrepared(cypher, params);
  }, 120_000);

  const names = (lines: string[]) => lines.map((l) => l.split('  ')[0]);

  describe('high_complexity', () => {
    it('orders by cyclomatic complexity with sloc and 1-based file:line', async () => {
      const r = await runQualityQuery(run, { preset: 'high_complexity', path: 'src/lib.ts' });
      // godFunction: 1 + 8 ifs + for + if + && + ternary = 13
      expect(r.lines[0]).toMatch(/^godFunction {2}src\/lib\.ts:\d+ {2}cx=13 sloc=\d+$/);
      expect(r.lines.some((l) => /^branchy {2}src\/lib\.ts:\d+ {2}cx=5 sloc=5$/.test(l))).toBe(true);
    });

    it('computes Python complexity: if + elif + and + for', async () => {
      const r = await runQualityQuery(run, { preset: 'high_complexity', path: 'src/svc.py' });
      expect(r.lines.find((l) => l.startsWith('classify'))).toMatch(/cx=5 sloc=8$/);
    });

    it('respects limit', async () => {
      const r = await runQualityQuery(run, { preset: 'high_complexity', limit: 2 });
      expect(r.count).toBe(2);
    });
  });

  it('god_functions reports only the function that is long, complex and wide', async () => {
    const r = await runQualityQuery(run, { preset: 'god_functions' });
    expect(names(r.lines)).toEqual(['godFunction']);
    expect(r.lines[0]).toMatch(/cx=13 sloc=\d+ out=8$/);
  });

  it('hotspots ranks the most-called symbol first', async () => {
    const r = await runQualityQuery(run, { preset: 'hotspots', path: 'src/lib.ts' });
    expect(r.lines[0]).toMatch(/^hub {2}src\/lib\.ts:\d+ {2}in=3$/);
  });

  it('high_fan_out ranks the widest caller first', async () => {
    const r = await runQualityQuery(run, { preset: 'high_fan_out', path: 'src/lib.ts' });
    expect(r.lines[0]).toMatch(/^godFunction .* out=8$/);
  });

  describe('dead_code', () => {
    it('lists unreferenced unexported symbols, not exported, called or test ones', async () => {
      const ts = names((await runQualityQuery(run, { preset: 'dead_code', path: 'src/' })).lines);
      expect(ts).toContain('deadOne');
      expect(ts).not.toContain('exportedUnused');
      expect(ts).not.toContain('entry');
      expect(ts).not.toContain('hub');
      expect(ts).not.toContain('godFunction');
      expect(ts).not.toContain('unusedInTest');
    });

    it('says in its note that results are candidates', async () => {
      const r = await runQualityQuery(run, { preset: 'dead_code' });
      expect(r.note).toMatch(/candidates/i);
    });
  });

  it('unused_injections flags the consumer that never calls its provider', async () => {
    const r = await runQualityQuery(run, { preset: 'unused_injections' });
    expect(r.lines.some((l) => l.startsWith('IdleConsumer '))).toBe(true);
    expect(r.lines.some((l) => l.startsWith('BusyConsumer '))).toBe(false);
  });

  it('rejects an unknown preset and a bad limit', async () => {
    await expect(runQualityQuery(run, { preset: 'nope' })).rejects.toThrow(/preset must be one of/);
    await expect(runQualityQuery(run, { preset: 'hotspots', limit: 0 })).rejects.toThrow(/limit/);
  });
});
