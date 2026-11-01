import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { whyIgnoredCommand, type WhyIgnoredOutput } from '../../src/cli/why-ignored.js';

describe('gitnexus why-ignored', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-why-ignored-'));
    // Hermetic: never read the developer's global git excludes.
    vi.stubEnv('GITNEXUS_NO_GLOBAL_IGNORE', '1');
    vi.stubEnv('GITNEXUS_NO_GITIGNORE', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(repo, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const write = async (rel: string, content = '') => {
    await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), content);
  };

  /** Run the real command against the temp repo and parse its stdout JSON. */
  const run = async (...paths: string[]): Promise<WhyIgnoredOutput> => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    await whyIgnoredCommand(
      paths.map((p) => path.join(repo, p)),
      { repo },
    );
    vi.restoreAllMocks();
    return JSON.parse(chunks.join(''));
  };

  it('names the nested .gitignore (and its directory) and the pattern', async () => {
    await write('pkg/.gitignore', 'local-*.ts\n');
    await write('pkg/local-a.ts');
    const { results } = await run('pkg/local-a.ts');
    expect(results).toEqual([
      {
        path: 'pkg/local-a.ts',
        indexed: false,
        excludedBy: { source: 'gitignore', file: 'pkg/.gitignore', pattern: 'local-*.ts' },
      },
    ]);
  });

  it('names a root .gitnexusignore rule and the pruned directory', async () => {
    await write('.gitnexusignore', '# legacy code\nscripts/legacy/\n');
    await write('scripts/legacy/old.ts');
    const { results } = await run('scripts/legacy/old.ts');
    expect(results).toEqual([
      {
        path: 'scripts/legacy/old.ts',
        indexed: false,
        excludedBy: {
          source: 'gitnexusignore',
          file: '.gitnexusignore',
          pattern: 'scripts/legacy/',
        },
        prunedAt: 'scripts/legacy',
      },
    ]);
  });

  it('names the built-in default directory', async () => {
    await write('web/node_modules/x/index.js');
    const { results } = await run('web/node_modules/x/index.js');
    expect(results).toEqual([
      {
        path: 'web/node_modules/x/index.js',
        indexed: false,
        excludedBy: { source: 'default-directory', pattern: 'node_modules' },
        prunedAt: 'web/node_modules',
      },
    ]);
  });

  it('names the binary extension rule, even when a negation matches the file', async () => {
    await write('.gitignore', '*.png\n!docs/assets/*.png\n');
    await write('docs/assets/logo.png');
    const { results } = await run('docs/assets/logo.png');
    expect(results).toEqual([
      {
        path: 'docs/assets/logo.png',
        indexed: false,
        excludedBy: { source: 'binary-extension', pattern: '.png' },
      },
    ]);
  });

  it('reports the negation that re-includes a default directory', async () => {
    await write('.gitnexusignore', '!__tests__/\n');
    await write('__tests__/a.test.ts');
    const { results } = await run('__tests__/a.test.ts');
    expect(results).toEqual([
      {
        path: '__tests__/a.test.ts',
        indexed: true,
        reincludedBy: {
          rule: { source: 'gitnexusignore', file: '.gitnexusignore', pattern: '!__tests__/' },
          at: '__tests__',
          overrides: { source: 'default-directory', pattern: '__tests__' },
        },
      },
    ]);
  });

  it('reports an ordinary source file as indexed', async () => {
    await write('.gitignore', 'dist/\n');
    await write('src/index.ts');
    const { results } = await run('src/index.ts');
    expect(results).toEqual([{ path: 'src/index.ts', indexed: true }]);
  });

  it('indexes fixtures/ and output/ by default', async () => {
    const { results } = await run('test/fixtures/a.ts', 'src/output/render.ts');
    expect(results.map((r) => r.indexed)).toEqual([true, true]);
  });

  it('reports hidden paths and files over the size cap', async () => {
    vi.stubEnv('GITNEXUS_MAX_FILE_SIZE', '1');
    await write('.github/workflows/ci.yml');
    await write('src/big.ts', 'x'.repeat(2048));
    const { results } = await run('.github/workflows/ci.yml', 'src/big.ts');
    expect(results).toEqual([
      {
        path: '.github/workflows/ci.yml',
        indexed: false,
        excludedBy: { source: 'hidden', pattern: '.github' },
      },
      {
        path: 'src/big.ts',
        indexed: false,
        excludedBy: {
          source: 'size-limit',
          pattern: '2048 bytes > 1024 bytes (GITNEXUS_MAX_FILE_SIZE)',
        },
      },
    ]);
  });

  it('fails with a non-zero exit code for a path outside the repository', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await whyIgnoredCommand([path.join(os.tmpdir(), 'elsewhere.ts')], { repo });
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalled();
  });
});
