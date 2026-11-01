import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeSemanticDiff, type SemanticChange } from '../../src/core/diff/semantic-diff.js';
import { parseDiffHunks } from '../../src/storage/git.js';
import { diffArgsFor } from '../helpers/detect-changes-diff-args.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

const TS_BEFORE = `export function add(a: number, b: number): number {
  return a + b;
}

export function legacy(x: string): string {
  return x;
}

export function greet(name: string): string {
  return 'hi ' + name;
}

export function computeTotal(items: number[]): number {
  let total = 0;
  for (const item of items) total += item;
  return total;
}

export function scale(v: number): number {
  return v * 2;
}

function internal(v: number): number {
  return v + 1;
}

export class Cart {
  checkout(user: string): boolean {
    return user.length > 0;
  }
}
`;

const TS_AFTER = `export function add(a: number, b: number, c: number): number {
  return a + b + c;
}

export function greet(name: string): string {
  return 'hello ' + name;
}

export function calculateTotal(items: number[]): number {
  let total = 0;
  for (const item of items) total += item;
  return total;
}

export function scale(v: number): number {
  return v * 2;
}

function internal(v: number, w: number): number {
  return v + w;
}

export function brandNew(flag: boolean): void {
  console.log(flag);
}

export class Cart {
  checkout(user: string, coupon: string): boolean {
    return user.length > 0 && coupon.length > 0;
  }
}
`;

const PY_BEFORE = `def public_fn(a, b):
    return a + b


def _private_fn(x):
    return x


class Service:
    def run(self, job):
        return job
`;

const PY_AFTER = `def public_fn(a, b, c):
    return a + b + c


def _private_fn(x, y):
    return x + y


class Service:
    def run(self, job):
        return job
`;

/** Files git reports for `scope`, exactly as detect_changes derives them. */
function changedFiles(cwd: string, scope: string) {
  const out = execFileSync('git', diffArgsFor(scope), { cwd, encoding: 'utf8' });
  return parseDiffHunks(out).map(({ filePath, oldFilePath }) => ({ filePath, oldFilePath }));
}

describe('detect_changes detail:"symbols" (semantic diff)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'gitnexus-semantic-diff-'));
    initGitRepo(repo);
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src/api.ts'), TS_BEFORE);
    writeFileSync(path.join(repo, 'src/svc.py'), PY_BEFORE);
    writeFileSync(path.join(repo, 'README.md'), '# before\n');
    commitAll(repo, 'initial');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const find = (changes: SemanticChange[], name: string) => changes.find((c) => c.name === name);

  it('classifies TypeScript changes and flags breaking ones', async () => {
    writeFileSync(path.join(repo, 'src/api.ts'), TS_AFTER);
    const result = await computeSemanticDiff(repo, changedFiles(repo, 'all'), 'all');
    const ts = result.changes.filter((c) => c.file === 'src/api.ts');

    // Exported function gained a parameter: breaking, with old -> new signature.
    expect(find(ts, 'add')).toMatchObject({
      change: 'SignatureChanged',
      type: 'Function',
      breaking: true,
    });
    expect(find(ts, 'add')?.from).toContain('b: number');
    expect(find(ts, 'add')?.to).toContain('c: number');

    // Exported function deleted: breaking.
    expect(find(ts, 'legacy')).toMatchObject({ change: 'Removed', breaking: true });

    // Body-only edit: reported, not breaking, no signature delta.
    const greet = find(ts, 'greet');
    expect(greet).toMatchObject({ change: 'BodyChanged', breaking: false });
    expect(greet?.from).toBeUndefined();

    // Exported rename: breaking, carries the previous name.
    expect(find(ts, 'calculateTotal')).toMatchObject({
      change: 'Renamed',
      old_name: 'computeTotal',
      breaking: true,
    });
    expect(find(ts, 'computeTotal')).toBeUndefined();

    // Additions are never breaking.
    expect(find(ts, 'brandNew')).toMatchObject({ change: 'Added', breaking: false });

    // Signature change on a non-exported function is not breaking.
    expect(find(ts, 'internal')).toMatchObject({ change: 'SignatureChanged', breaking: false });

    // Method signature change is attributed to its class.
    expect(find(ts, 'Cart.checkout')).toMatchObject({
      change: 'SignatureChanged',
      type: 'Method',
      breaking: true,
    });

    // Untouched symbols produce nothing.
    expect(find(ts, 'scale')).toBeUndefined();
    expect(find(ts, 'Cart')).toBeUndefined();
  });

  it('classifies Python changes using underscore-privacy for exports', async () => {
    writeFileSync(path.join(repo, 'src/svc.py'), PY_AFTER);
    const result = await computeSemanticDiff(repo, changedFiles(repo, 'all'), 'all');
    const py = result.changes.filter((c) => c.file === 'src/svc.py');

    expect(find(py, 'public_fn')).toMatchObject({ change: 'SignatureChanged', breaking: true });
    expect(find(py, '_private_fn')).toMatchObject({ change: 'SignatureChanged', breaking: false });
    expect(find(py, 'Service.run')).toBeUndefined();
    expect(py).toHaveLength(2);
  });

  it('counts breaking changes and ignores non-source files', async () => {
    writeFileSync(path.join(repo, 'src/api.ts'), TS_AFTER);
    writeFileSync(path.join(repo, 'README.md'), '# after\n');
    const result = await computeSemanticDiff(repo, changedFiles(repo, 'all'), 'all');

    expect(result.changes.every((c) => c.file === 'src/api.ts')).toBe(true);
    // add, legacy, computeTotal rename, Cart.checkout
    expect(result.breaking_count).toBe(4);
    expect(result.files_analyzed).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it('reads the staged version for scope "staged" and the index for "unstaged"', async () => {
    writeFileSync(path.join(repo, 'src/api.ts'), TS_AFTER);
    execFileSync('git', ['add', 'src/api.ts'], { cwd: repo });
    // Working tree then drifts further than the index.
    writeFileSync(path.join(repo, 'src/api.ts'), TS_AFTER + '\nexport const extra = 1;\n');

    const staged = await computeSemanticDiff(repo, changedFiles(repo, 'staged'), 'staged');
    expect(find(staged.changes, 'extra')).toBeUndefined();
    expect(find(staged.changes, 'brandNew')).toMatchObject({ change: 'Added' });

    const unstaged = await computeSemanticDiff(repo, changedFiles(repo, 'unstaged'), 'unstaged');
    expect(unstaged.changes.map((c) => `${c.change}:${c.name}`)).toEqual(['Added:extra']);
  });

  it('flags an exported symbol that became private as a breaking visibility change', async () => {
    writeFileSync(
      path.join(repo, 'src/api.ts'),
      TS_BEFORE.replace('export function scale', 'function scale'),
    );
    const result = await computeSemanticDiff(repo, changedFiles(repo, 'all'), 'all');
    expect(result.changes).toEqual([
      expect.objectContaining({ name: 'scale', change: 'VisibilityChanged', breaking: true }),
    ]);
  });

  it('treats gaining an export as non-breaking', async () => {
    writeFileSync(
      path.join(repo, 'src/api.ts'),
      TS_BEFORE.replace('function internal', 'export function internal'),
    );
    const result = await computeSemanticDiff(repo, changedFiles(repo, 'all'), 'all');
    expect(result.changes).toEqual([
      expect.objectContaining({ name: 'internal', change: 'VisibilityChanged', breaking: false }),
    ]);
  });

  it('reports a deleted file as removed symbols, and compares against base_ref', async () => {
    execFileSync('git', ['rm', '-q', 'src/svc.py'], { cwd: repo });
    commitAll(repo, 'drop python');
    const against = execFileSync('git', ['rev-parse', 'HEAD~1'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const out = execFileSync('git', diffArgsFor('compare', against), {
      cwd: repo,
      encoding: 'utf8',
    });
    const result = await computeSemanticDiff(
      repo,
      parseDiffHunks(out).map(({ filePath, oldFilePath }) => ({ filePath, oldFilePath })),
      'compare',
      against,
    );
    const names = result.changes.map((c) => `${c.change}:${c.name}:${c.breaking}`).sort();
    expect(names).toEqual([
      'Removed:Service.run:true',
      'Removed:Service:true',
      'Removed:_private_fn:false',
      'Removed:public_fn:true',
    ]);
  });

  it('degrades to no changes for a language it has no definitions for', async () => {
    writeFileSync(path.join(repo, 'a.cob'), 'x\n');
    commitAll(repo, 'cobol');
    writeFileSync(path.join(repo, 'a.cob'), 'y\n');
    const result = await computeSemanticDiff(repo, [{ filePath: 'a.cob' }], 'all');
    expect(result.changes).toEqual([]);
    expect(result.breaking_count).toBe(0);
  });

  it('diffs other grammars too (Go: exported by capitalisation)', async () => {
    writeFileSync(
      path.join(repo, 'm.go'),
      'package m\n\nfunc Sum(a int, b int) int {\n\treturn a + b\n}\n\nfunc helper(a int) int {\n\treturn a\n}\n',
    );
    commitAll(repo, 'go');
    writeFileSync(
      path.join(repo, 'm.go'),
      'package m\n\nfunc Sum(a int, b int, c int) int {\n\treturn a + b + c\n}\n\nfunc helper(a int, b int) int {\n\treturn a\n}\n',
    );
    const result = await computeSemanticDiff(repo, changedFiles(repo, 'all'), 'all');
    expect(result.changes.map((c) => `${c.name}:${c.change}:${c.breaking}`).sort()).toEqual([
      'Sum:SignatureChanged:true',
      'helper:SignatureChanged:false',
    ]);
  });
});
