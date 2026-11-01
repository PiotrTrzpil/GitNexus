/**
 * File / directory move with import rewiring (rename tool, type "file" | "directory").
 * Real temp-dir repositories; ts-morph runs in its worker thread.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMovePlans, moveRename } from '../../src/mcp/local/rename/move/file-move.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

let root: string;

async function write(rel: string, text: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text);
}
const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const exists = (rel: string) =>
  fs.access(path.join(root, rel)).then(
    () => true,
    () => false,
  );

/** Every file under root with its content, to prove a preview changes nothing. */
async function tree(dir = root): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await tree(abs));
    else out[path.relative(root, abs)] = await fs.readFile(abs, 'utf8');
  }
  return out;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-move-'));
  await write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022' },
      include: ['src'],
    }),
  );
  await write('src/utils/helpers.ts', `export const helper = (n: number) => n + 1;\n`);
  await write(
    'src/utils/format.ts',
    `import { helper } from './helpers';\nexport const fmt = (n: number) => String(helper(n));\n`,
  );
  await write(
    'src/app.ts',
    `import { helper } from './utils/helpers';\nimport { fmt } from './utils/format';\nexport const out = fmt(helper(1));\n`,
  );
  await write(
    'src/feature/index.ts',
    `import { helper } from '../utils/helpers';\nexport const f = helper(2);\n`,
  );
});

afterEach(async () => {
  clearMovePlans();
  await fs.rm(root, { recursive: true, force: true });
});

describe('file move', () => {
  it('previews by default and leaves the tree untouched', async () => {
    const before = await tree();
    const preview = await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'src/utils/helpers.ts',
      to: 'src/lib/helpers.ts',
    });
    expect(preview.status).toBe('success');
    expect(preview.applied).toBe(false);
    expect(preview.dry_run).toBe(true);
    expect(typeof preview.plan_token).toBe('string');
    expect(preview.files_moved).toEqual([{ from: 'src/utils/helpers.ts', to: 'src/lib/helpers.ts' }]);
    expect(preview.edits).toEqual(
      expect.arrayContaining([
        {
          filePath: 'src/app.ts',
          line: 1,
          old_text: `import { helper } from './utils/helpers';`,
          new_text: `import { helper } from './lib/helpers';`,
          confidence: 'ts_morph',
        },
      ]),
    );
    expect(await tree()).toEqual(before);
  });

  it('applies with the preview token: moves the file and rewrites every importer', async () => {
    const preview = await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'src/utils/helpers.ts',
      to: 'src/lib/helpers.ts',
    });
    const applied = await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'src/utils/helpers.ts',
      to: 'src/lib/helpers.ts',
      dryRun: false,
      planToken: preview.plan_token,
    });
    expect(applied.status).toBe('success');
    expect(applied.applied).toBe(true);
    expect(await exists('src/utils/helpers.ts')).toBe(false);
    expect(await read('src/lib/helpers.ts')).toBe(`export const helper = (n: number) => n + 1;\n`);
    expect(await read('src/app.ts')).toContain(`from './lib/helpers'`);
    expect(await read('src/utils/format.ts')).toContain(`from '../lib/helpers'`);
    expect(await read('src/feature/index.ts')).toContain(`from '../lib/helpers'`);
    // untouched import stays as written
    expect(await read('src/app.ts')).toContain(`from './utils/format'`);
  });

  it('rewrites the moved file’s own relative imports', async () => {
    const preview = await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'src/utils/format.ts',
      to: 'src/lib/deep/format.ts',
    });
    await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'src/utils/format.ts',
      to: 'src/lib/deep/format.ts',
      dryRun: false,
      planToken: preview.plan_token,
    });
    expect(await read('src/lib/deep/format.ts')).toContain(`from '../../utils/helpers'`);
    expect(await read('src/app.ts')).toContain(`from './lib/deep/format'`);
  });

  it('refuses to apply without a plan_token, and a token is single-use', async () => {
    const args = {
      repoPath: root,
      kind: 'file' as const,
      from: 'src/utils/helpers.ts',
      to: 'src/lib/helpers.ts',
    };
    const noToken = await moveRename({ ...args, dryRun: false });
    expect(noToken).toMatchObject({ status: 'failed', code: 'plan_required', applied: false });
    expect(await exists('src/utils/helpers.ts')).toBe(true);

    const preview = await moveRename(args);
    const first = await moveRename({ ...args, dryRun: false, planToken: preview.plan_token });
    expect(first.applied).toBe(true);
  });

  it('spends the token on a failed apply attempt', async () => {
    const args = {
      repoPath: root,
      kind: 'file' as const,
      from: 'src/utils/helpers.ts',
      to: 'src/lib/helpers.ts',
    };
    const preview = await moveRename(args);
    await write('src/late.ts', `import { helper } from './utils/helpers';\n`);
    const stale = await moveRename({ ...args, dryRun: false, planToken: preview.plan_token });
    expect(stale.code).toBe('plan_stale');
    const retry = await moveRename({ ...args, dryRun: false, planToken: preview.plan_token });
    expect(retry).toMatchObject({ status: 'failed', code: 'plan_invalid', applied: false });
    expect(await exists('src/utils/helpers.ts')).toBe(true);
  });

  it('rejects a token issued for a different destination', async () => {
    const preview = await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'src/utils/helpers.ts',
      to: 'src/lib/helpers.ts',
    });
    const result = await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'src/utils/helpers.ts',
      to: 'src/elsewhere/helpers.ts',
      dryRun: false,
      planToken: preview.plan_token,
    });
    expect(result).toMatchObject({ status: 'failed', code: 'plan_invalid' });
    expect(await exists('src/utils/helpers.ts')).toBe(true);
  });

  it('refuses a stale preview when an importer changed in between', async () => {
    const args = {
      repoPath: root,
      kind: 'file' as const,
      from: 'src/utils/helpers.ts',
      to: 'src/lib/helpers.ts',
    };
    const preview = await moveRename(args);
    await write('src/late.ts', `import { helper } from './utils/helpers';\nexport const late = helper(3);\n`);
    const result = await moveRename({ ...args, dryRun: false, planToken: preview.plan_token });
    expect(result).toMatchObject({ status: 'failed', code: 'plan_stale', applied: false });
    expect(await exists('src/utils/helpers.ts')).toBe(true);
    expect(await read('src/late.ts')).toContain(`'./utils/helpers'`);
  });

  it('fails when the source is missing or the target exists', async () => {
    expect(
      await moveRename({ repoPath: root, kind: 'file', from: 'src/nope.ts', to: 'src/x.ts' }),
    ).toMatchObject({ status: 'failed', code: 'source_missing' });
    expect(
      await moveRename({
        repoPath: root,
        kind: 'file',
        from: 'src/utils/helpers.ts',
        to: 'src/utils/format.ts',
      }),
    ).toMatchObject({ status: 'failed', code: 'target_exists' });
    expect(
      await moveRename({
        repoPath: root,
        kind: 'file',
        from: 'src/utils/helpers.ts',
        to: '../outside.ts',
      }),
    ).toMatchObject({ status: 'failed', code: 'invalid_request' });
  });

  it('moves a non-code file without import rewriting', async () => {
    await write('docs/notes.md', '# notes\n');
    const preview = await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'docs/notes.md',
      to: 'documentation/notes.md',
    });
    expect(preview.edits).toEqual([]);
    await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'docs/notes.md',
      to: 'documentation/notes.md',
      dryRun: false,
      planToken: preview.plan_token,
    });
    expect(await read('documentation/notes.md')).toBe('# notes\n');
    expect(await exists('docs')).toBe(false);
  });

  it('reports Python as not supported and touches nothing', async () => {
    await write('pkg/mod.py', 'VALUE = 1\n');
    await write('pkg/user.py', 'from pkg.mod import VALUE\n');
    const before = await tree();
    const result = await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'pkg/mod.py',
      to: 'pkg/sub/mod.py',
    });
    expect(result).toMatchObject({ status: 'failed', code: 'unsupported_language', applied: false });
    expect(result.error).toMatch(/not supported yet/i);
    expect(await tree()).toEqual(before);

    const dir = await moveRename({ repoPath: root, kind: 'directory', from: 'pkg', to: 'pkg2' });
    expect(dir).toMatchObject({ status: 'failed', code: 'unsupported_language' });
  });
});

describe('directory move', () => {
  it('previews, then moves the tree and rewrites outside and inside imports', async () => {
    const before = await tree();
    const preview = await moveRename({
      repoPath: root,
      kind: 'directory',
      from: 'src/utils',
      to: 'src/shared/core',
    });
    expect(preview.status).toBe('success');
    expect(preview.files_moved).toEqual([
      { from: 'src/utils/format.ts', to: 'src/shared/core/format.ts' },
      { from: 'src/utils/helpers.ts', to: 'src/shared/core/helpers.ts' },
    ]);
    expect(await tree()).toEqual(before);

    const applied = await moveRename({
      repoPath: root,
      kind: 'directory',
      from: 'src/utils',
      to: 'src/shared/core',
      dryRun: false,
      planToken: preview.plan_token,
    });
    expect(applied.applied).toBe(true);
    expect(await exists('src/utils')).toBe(false);
    // intra-directory import is unchanged: both files moved together
    expect(await read('src/shared/core/format.ts')).toContain(`from './helpers'`);
    expect(await read('src/app.ts')).toContain(`from './shared/core/helpers'`);
    expect(await read('src/app.ts')).toContain(`from './shared/core/format'`);
    expect(await read('src/feature/index.ts')).toContain(`from '../shared/core/helpers'`);
  });

  it('moves non-code files in the directory alongside the code', async () => {
    await write('src/utils/data.json', '{"a":1}\n');
    const preview = await moveRename({
      repoPath: root,
      kind: 'directory',
      from: 'src/utils',
      to: 'src/moved',
    });
    await moveRename({
      repoPath: root,
      kind: 'directory',
      from: 'src/utils',
      to: 'src/moved',
      dryRun: false,
      planToken: preview.plan_token,
    });
    expect(await read('src/moved/data.json')).toBe('{"a":1}\n');
    expect(await exists('src/utils')).toBe(false);
  });

  it('rejects moving a directory into itself', async () => {
    const result = await moveRename({
      repoPath: root,
      kind: 'directory',
      from: 'src/utils',
      to: 'src/utils/inner',
    });
    expect(result).toMatchObject({ status: 'failed', code: 'invalid_request' });
  });
});

describe('hard timeout', () => {
  it('terminates the ts-morph worker and reports a planning failure, writing nothing', async () => {
    const before = await tree();
    const result = await moveRename({
      repoPath: root,
      kind: 'file',
      from: 'src/utils/helpers.ts',
      to: 'src/lib/helpers.ts',
      timeoutMs: 1,
    });
    expect(result).toMatchObject({ status: 'failed', code: 'planning_failed', applied: false });
    expect(result.error).toMatch(/timed out after 1ms/);
    expect(await tree()).toEqual(before);
  });
});

describe('LocalBackend rename routing', () => {
  function backendFor(): { call: (p: Record<string, unknown>) => Promise<any> } {
    const backend = new LocalBackend() as any;
    backend.ensureInitialized = async () => {};
    return { call: (p) => backend.rename({ repoPath: root, lbugPath: '' }, p) };
  }

  it('routes type "directory" to a move preview without touching the tree', async () => {
    const before = await tree();
    const result = await backendFor().call({
      type: 'directory',
      path: 'src/utils',
      new_name: 'src/u2',
    });
    expect(result).toMatchObject({ status: 'success', type: 'directory', dry_run: true, applied: false });
    expect(result.files_moved).toHaveLength(2);
    expect(await tree()).toEqual(before);
  });

  it('rejects apply without plan_token and an unknown type', async () => {
    const b = backendFor();
    expect(
      await b.call({ type: 'file', path: 'src/app.ts', new_name: 'src/b.ts', dry_run: false }),
    ).toMatchObject({ status: 'failed', code: 'plan_required' });
    expect(await b.call({ type: 'module', new_name: 'x' })).toEqual({
      error: 'Parameter "type" must be "symbol", "file" or "directory".',
    });
  });
});
