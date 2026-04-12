/**
 * Integration Tests: Rename via Public API
 *
 * Tests the full LocalBackend.callTool('rename', ...) flow — the same API
 * used by the CLI and MCP server. This ensures:
 * 1. Symbol lookup via context() finds the correct file/line
 * 2. Engine selection (ts_morph, rope, graph_text_search) is correct
 * 3. Edits are applied correctly to the filesystem
 *
 * Categories:
 * 1. File rename (type: 'file') — ts-morph import path updates
 * 2. Directory rename (type: 'directory') — ts-morph import path updates
 * 3. Symbol rename (ts_morph engine) — TS/JS via language service
 * 4. Symbol rename (graph_text_search fallback) — non-TS/JS or fallback
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, cleanupOldKuzuFiles, loadMeta } from '../../src/storage/repo-manager.js';
import { withTestLbugDB, type FTSIndexDef } from '../helpers/test-indexed-db.js';

// Mock repo-manager — we'll configure it dynamically per test group
vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  loadMeta: vi.fn().mockResolvedValue(null),
}));

// ─── Helpers ────────────────────────────────────────────────────────────

interface TempProject {
  root: string;
  cleanup: () => Promise<void>;
}

/** Create a temp directory with files and a tsconfig.json for TS projects. */
async function createTempProject(
  files: Record<string, string>,
  includeTsConfig = true,
): Promise<TempProject> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-api-'));

  if (includeTsConfig) {
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          noEmit: true,
          allowJs: true,
        },
        include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
      }),
    );
  }

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  return {
    root,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** Read a file from the temp project. */
async function readFile(project: TempProject, filePath: string): Promise<string> {
  return fs.readFile(path.join(project.root, filePath), 'utf-8');
}

/** Check whether a file exists in the temp project. */
async function fileExists(project: TempProject, filePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(project.root, filePath));
    return true;
  } catch {
    return false;
  }
}

/** Check whether a directory exists in the temp project. */
async function dirExists(project: TempProject, dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(project.root, dirPath));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. File rename via API (type: 'file')
// ═══════════════════════════════════════════════════════════════════════════

// File renames don't need graph data — they bypass context lookup
const FILE_RENAME_SEED: string[] = [];
const FILE_RENAME_FTS: FTSIndexDef[] = [];

withTestLbugDB('rename-api-file', (handle) => {
  describe('file rename via LocalBackend.callTool', () => {
    let backend: LocalBackend;
    let project: TempProject;

    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend; _project?: TempProject };
      backend = ext._backend!;
      project = ext._project!;
    });

    afterAll(async () => {
      const ext = handle as typeof handle & { _project?: TempProject };
      if (ext._project) await ext._project.cleanup();
    });

    it('previews file move in dry run without modifying files', async () => {
      const result = await backend.callTool('rename', {
        type: 'file',
        symbol_name: 'src/utils/helpers.ts',
        new_name: 'src/lib/helpers.ts',
        dry_run: true,
      });

      expect(result.status).toBe('success');
      expect(result.type).toBe('file');
      expect(result.engine).toBe('ts_morph');
      expect(result.old_name).toBe('src/utils/helpers.ts');
      expect(result.new_name).toBe('src/lib/helpers.ts');
      expect(result.files_moved).toBe(1);
      expect(result.applied).toBe(false);

      // Dry run must NOT modify files
      expect(await fileExists(project, 'src/utils/helpers.ts')).toBe(true);
      expect(await fileExists(project, 'src/lib/helpers.ts')).toBe(false);
    });

    it('applies file move and updates imports', async () => {
      const result = await backend.callTool('rename', {
        type: 'file',
        symbol_name: 'src/utils/helpers.ts',
        new_name: 'src/lib/helpers.ts',
        dry_run: false,
      });

      expect(result.status).toBe('success');
      expect(result.engine).toBe('ts_morph');
      expect(result.files_moved).toBe(1);
      expect(result.applied).toBe(true);

      // File should be moved
      expect(await fileExists(project, 'src/utils/helpers.ts')).toBe(false);
      expect(await fileExists(project, 'src/lib/helpers.ts')).toBe(true);

      // Import paths should be updated
      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./lib/helpers');
      expect(appContent).not.toContain('./utils/helpers');
    });

    it('returns error for nonexistent source file', async () => {
      const result = await backend.callTool('rename', {
        type: 'file',
        symbol_name: 'src/nonexistent.ts',
        new_name: 'src/dest.ts',
        dry_run: true,
      });

      expect(result.error).toBeDefined();
    });
  });
}, {
  seed: FILE_RENAME_SEED,
  ftsIndexes: FILE_RENAME_FTS,
  poolAdapter: true,
  afterSetup: async (handle) => {
    // Create temp project with files for file rename tests
    const project = await createTempProject({
      'src/utils/helpers.ts': `export function helper() { return 42; }`,
      'src/app.ts': `import { helper } from "./utils/helpers";\nconsole.log(helper());`,
    });

    vi.mocked(listRegisteredRepos).mockResolvedValue([{
      name: 'test-repo',
      path: project.root,
      storagePath: handle.tmpHandle.dbPath,
      indexedAt: new Date().toISOString(),
      lastCommit: 'abc123',
      stats: { files: 2, nodes: 1, communities: 0, processes: 0 },
    }]);

    const backend = new LocalBackend();
    await backend.init();
    (handle as any)._backend = backend;
    (handle as any)._project = project;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Directory rename via API (type: 'directory')
// ═══════════════════════════════════════════════════════════════════════════

const DIR_RENAME_SEED: string[] = [];
const DIR_RENAME_FTS: FTSIndexDef[] = [];

withTestLbugDB('rename-api-directory', (handle) => {
  describe('directory rename via LocalBackend.callTool', () => {
    let backend: LocalBackend;
    let project: TempProject;

    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend; _project?: TempProject };
      backend = ext._backend!;
      project = ext._project!;
    });

    afterAll(async () => {
      const ext = handle as typeof handle & { _project?: TempProject };
      if (ext._project) await ext._project.cleanup();
    });

    it('previews directory move in dry run', async () => {
      const result = await backend.callTool('rename', {
        type: 'directory',
        symbol_name: 'src/canvas',
        new_name: 'src/view',
        dry_run: true,
      });

      expect(result.status).toBe('success');
      expect(result.type).toBe('directory');
      expect(result.engine).toBe('ts_morph');
      expect(result.files_moved).toBe(2);
      expect(result.applied).toBe(false);

      // Dry run must NOT modify files
      expect(await dirExists(project, 'src/canvas')).toBe(true);
      expect(await dirExists(project, 'src/view')).toBe(false);
    });

    it('applies directory move and updates imports', async () => {
      const result = await backend.callTool('rename', {
        type: 'directory',
        symbol_name: 'src/canvas',
        new_name: 'src/view',
        dry_run: false,
      });

      expect(result.status).toBe('success');
      expect(result.engine).toBe('ts_morph');
      expect(result.files_moved).toBe(2);
      expect(result.applied).toBe(true);

      // Directory should be moved
      expect(await dirExists(project, 'src/canvas')).toBe(false);
      expect(await dirExists(project, 'src/view')).toBe(true);
      expect(await fileExists(project, 'src/view/renderer.ts')).toBe(true);
      expect(await fileExists(project, 'src/view/types.ts')).toBe(true);

      // Import paths should be updated
      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./view/renderer');
      expect(appContent).not.toContain('./canvas/');
    });

    it('returns error for nonexistent source directory', async () => {
      const result = await backend.callTool('rename', {
        type: 'directory',
        symbol_name: 'src/nonexistent',
        new_name: 'src/dest',
        dry_run: true,
      });

      expect(result.error).toBeDefined();
    });
  });
}, {
  seed: DIR_RENAME_SEED,
  ftsIndexes: DIR_RENAME_FTS,
  poolAdapter: true,
  afterSetup: async (handle) => {
    // Create temp project with directory structure
    const project = await createTempProject({
      'src/canvas/renderer.ts': `export function render() { return "canvas"; }`,
      'src/canvas/types.ts': `export interface Config { width: number; }`,
      'src/app.ts': `import { render } from "./canvas/renderer";\nimport { Config } from "./canvas/types";\nrender();`,
    });

    vi.mocked(listRegisteredRepos).mockResolvedValue([{
      name: 'test-repo',
      path: project.root,
      storagePath: handle.tmpHandle.dbPath,
      indexedAt: new Date().toISOString(),
      lastCommit: 'abc123',
      stats: { files: 3, nodes: 2, communities: 0, processes: 0 },
    }]);

    const backend = new LocalBackend();
    await backend.init();
    (handle as any)._backend = backend;
    (handle as any)._project = project;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Symbol rename via API (ts_morph engine)
// ═══════════════════════════════════════════════════════════════════════════

// Source files for ts_morph symbol rename tests
// IMPORTANT: Line numbers in seed data MUST match these files exactly
const TS_SYMBOL_FILES = {
  'src/math.ts': [
    'export function calculateSum(a: number, b: number): number {',  // line 1
    '  return a + b;',                                                // line 2
    '}',                                                              // line 3
    '',                                                               // line 4
    'export function multiply(a: number, b: number): number {',       // line 5
    '  return calculateSum(a, 0) + a * b;',                           // line 6
    '}',                                                              // line 7
  ].join('\n'),
  'src/main.ts': [
    'import { calculateSum } from "./math";',                         // line 1
    '',                                                               // line 2
    'const result = calculateSum(1, 2);',                             // line 3
    'console.log(result);',                                           // line 4
  ].join('\n'),
};

// Seed data matching the source files above
const TS_SYMBOL_SEED = [
  // Files
  `CREATE (f:File {id: 'file:math.ts', name: 'math.ts', filePath: 'src/math.ts', content: ''})`,
  `CREATE (f:File {id: 'file:main.ts', name: 'main.ts', filePath: 'src/main.ts', content: ''})`,
  // Functions — line numbers MUST match source files
  `CREATE (fn:Function {id: 'func:calculateSum', name: 'calculateSum', filePath: 'src/math.ts', startLine: 1, endLine: 3, startColumn: 17, isExported: true, content: 'export function calculateSum(a: number, b: number): number { return a + b; }', description: ''})`,
  `CREATE (fn:Function {id: 'func:multiply', name: 'multiply', filePath: 'src/math.ts', startLine: 5, endLine: 7, startColumn: 17, isExported: true, content: '', description: ''})`,
  // Relationships
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:multiply' AND b.id = 'func:calculateSum'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
];

const TS_SYMBOL_FTS: FTSIndexDef[] = [
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
];

withTestLbugDB('rename-api-ts-symbol', (handle) => {
  describe('symbol rename via LocalBackend.callTool (ts_morph engine)', () => {
    let backend: LocalBackend;
    let project: TempProject;

    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend; _project?: TempProject };
      backend = ext._backend!;
      project = ext._project!;
    });

    afterAll(async () => {
      const ext = handle as typeof handle & { _project?: TempProject };
      if (ext._project) await ext._project.cleanup();
    });

    it('renames TS function via ts_morph engine (dry run)', async () => {
      const result = await backend.callTool('rename', {
        symbol_name: 'calculateSum',
        new_name: 'add',
        dry_run: true,
      });

      expect(result.status).toBe('success');
      expect(result.engine).toBe('ts_morph');
      expect(result.old_name).toBe('calculateSum');
      expect(result.new_name).toBe('add');
      expect(result.files_affected).toBeGreaterThanOrEqual(2);
      expect(result.applied).toBe(false);

      // Dry run must NOT modify files
      const mathContent = await readFile(project, 'src/math.ts');
      expect(mathContent).toContain('calculateSum');
      expect(mathContent).not.toContain('function add(');
    });

    it('renames TS function via ts_morph engine (apply)', async () => {
      const result = await backend.callTool('rename', {
        symbol_name: 'calculateSum',
        new_name: 'add',
        dry_run: false,
      });

      expect(result.status).toBe('success');
      expect(result.engine).toBe('ts_morph');
      expect(result.applied).toBe(true);

      // Definition should be renamed
      const mathContent = await readFile(project, 'src/math.ts');
      expect(mathContent).toContain('export function add(');
      expect(mathContent).toContain('return add(a, 0)'); // internal call
      expect(mathContent).not.toContain('calculateSum');

      // Import and usage should be renamed
      const mainContent = await readFile(project, 'src/main.ts');
      expect(mainContent).toContain('import { add } from "./math"');
      expect(mainContent).toContain('const result = add(1, 2)');
      expect(mainContent).not.toContain('calculateSum');
    });

    it('returns not_found for unknown symbol', async () => {
      const result = await backend.callTool('rename', {
        symbol_name: 'nonexistentSymbol123',
        new_name: 'newName',
        dry_run: true,
      });

      expect(result.status).toBe('not_found');
      // not_found response has 'message' field, not 'error'
      expect(result.message).toMatch(/not found/i);
    });

    it('returns error when new_name equals old_name', async () => {
      const result = await backend.callTool('rename', {
        symbol_name: 'multiply',
        new_name: 'multiply',
        dry_run: true,
      });

      expect(result.error).toMatch(/same as the current name/i);
    });
  });
}, {
  seed: TS_SYMBOL_SEED,
  ftsIndexes: TS_SYMBOL_FTS,
  poolAdapter: true,
  afterSetup: async (handle) => {
    // Create temp project with files matching the seed data
    const project = await createTempProject(TS_SYMBOL_FILES);

    vi.mocked(listRegisteredRepos).mockResolvedValue([{
      name: 'test-repo',
      path: project.root,
      storagePath: handle.tmpHandle.dbPath,
      indexedAt: new Date().toISOString(),
      lastCommit: 'abc123',
      stats: { files: 2, nodes: 2, communities: 0, processes: 0 },
    }]);

    const backend = new LocalBackend();
    await backend.init();
    (handle as any)._backend = backend;
    (handle as any)._project = project;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Symbol rename via API (graph_text_search fallback)
// ═══════════════════════════════════════════════════════════════════════════

// For graph_text_search tests, we use Go files which don't have ts-morph/rope support
const GRAPH_FALLBACK_FILES = {
  'src/utils.go': [
    'package utils',                                    // line 1
    '',                                                 // line 2
    'func GetData() string {',                          // line 3
    '  return "data"',                                  // line 4
    '}',                                                // line 5
  ].join('\n'),
  'src/main.go': [
    'package main',                                     // line 1
    '',                                                 // line 2
    'import "project/utils"',                           // line 3
    '',                                                 // line 4
    'func main() {',                                    // line 5
    '  result := utils.GetData()',                      // line 6
    '  println(result)',                                // line 7
    '}',                                                // line 8
  ].join('\n'),
};

// Seed data for graph_text_search fallback tests
const GRAPH_FALLBACK_SEED = [
  // Files
  `CREATE (f:File {id: 'file:utils.go', name: 'utils.go', filePath: 'src/utils.go', content: ''})`,
  `CREATE (f:File {id: 'file:main.go', name: 'main.go', filePath: 'src/main.go', content: ''})`,
  // Functions
  `CREATE (fn:Function {id: 'func:GetData', name: 'GetData', filePath: 'src/utils.go', startLine: 3, endLine: 5, startColumn: 6, isExported: true, content: 'func GetData() string { return "data" }', description: ''})`,
  `CREATE (fn:Function {id: 'func:main', name: 'main', filePath: 'src/main.go', startLine: 5, endLine: 8, startColumn: 6, isExported: false, content: '', description: ''})`,
  // Relationships — main calls GetData
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:main' AND b.id = 'func:GetData'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
];

const GRAPH_FALLBACK_FTS: FTSIndexDef[] = [
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
];

withTestLbugDB('rename-api-graph-fallback', (handle) => {
  describe('symbol rename via LocalBackend.callTool (graph_text_search fallback)', () => {
    let backend: LocalBackend;
    let project: TempProject;

    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend; _project?: TempProject };
      backend = ext._backend!;
      project = ext._project!;
    });

    afterAll(async () => {
      const ext = handle as typeof handle & { _project?: TempProject };
      if (ext._project) await ext._project.cleanup();
    });

    it('renames Go function via graph_text_search (dry run)', async () => {
      const result = await backend.callTool('rename', {
        symbol_name: 'GetData',
        new_name: 'FetchData',
        dry_run: true,
      });

      expect(result.status).toBe('success');
      expect(result.engine).toBe('graph_text_search');
      expect(result.old_name).toBe('GetData');
      expect(result.new_name).toBe('FetchData');
      expect(result.files_affected).toBeGreaterThanOrEqual(1);
      expect(result.applied).toBe(false);

      // Dry run must NOT modify files
      const utilsContent = await readFile(project, 'src/utils.go');
      expect(utilsContent).toContain('GetData');
      expect(utilsContent).not.toContain('FetchData');
    });

    it('renames Go function via graph_text_search (apply)', async () => {
      const result = await backend.callTool('rename', {
        symbol_name: 'GetData',
        new_name: 'FetchData',
        dry_run: false,
      });

      expect(result.status).toBe('success');
      expect(result.engine).toBe('graph_text_search');
      expect(result.applied).toBe(true);

      // Definition should be renamed
      const utilsContent = await readFile(project, 'src/utils.go');
      expect(utilsContent).toContain('func FetchData()');
      expect(utilsContent).not.toContain('GetData');

      // Usage should be renamed via text search
      const mainContent = await readFile(project, 'src/main.go');
      expect(mainContent).toContain('utils.FetchData()');
      expect(mainContent).not.toContain('GetData');
    });

    it('reports graph_edits and text_search_edits counts', async () => {
      // Reset files first
      await fs.writeFile(path.join(project.root, 'src/utils.go'), GRAPH_FALLBACK_FILES['src/utils.go']);
      await fs.writeFile(path.join(project.root, 'src/main.go'), GRAPH_FALLBACK_FILES['src/main.go']);

      const result = await backend.callTool('rename', {
        symbol_name: 'GetData',
        new_name: 'RetrieveData',
        dry_run: true,
      });

      expect(result.status).toBe('success');
      expect(result.engine).toBe('graph_text_search');
      // Should have edit counts
      expect(typeof result.graph_edits).toBe('number');
      expect(typeof result.text_search_edits).toBe('number');
      expect(result.total_edits).toBe(result.graph_edits + result.text_search_edits);
    });
  });
}, {
  seed: GRAPH_FALLBACK_SEED,
  ftsIndexes: GRAPH_FALLBACK_FTS,
  poolAdapter: true,
  afterSetup: async (handle) => {
    // Create temp project with Go files (no tsconfig needed)
    const project = await createTempProject(GRAPH_FALLBACK_FILES, false);

    vi.mocked(listRegisteredRepos).mockResolvedValue([{
      name: 'test-repo',
      path: project.root,
      storagePath: handle.tmpHandle.dbPath,
      indexedAt: new Date().toISOString(),
      lastCommit: 'abc123',
      stats: { files: 2, nodes: 2, communities: 0, processes: 0 },
    }]);

    const backend = new LocalBackend();
    await backend.init();
    (handle as any)._backend = backend;
    (handle as any)._project = project;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Edge cases and error handling
// ═══════════════════════════════════════════════════════════════════════════

const ERROR_HANDLING_SEED = [
  `CREATE (fn:Function {id: 'func:ambiguous', name: 'process', filePath: 'src/a.ts', startLine: 1, endLine: 3, startColumn: 17, isExported: true, content: '', description: ''})`,
  `CREATE (fn:Function {id: 'func:ambiguous2', name: 'process', filePath: 'src/b.ts', startLine: 1, endLine: 3, startColumn: 17, isExported: true, content: '', description: ''})`,
];

const ERROR_HANDLING_FTS: FTSIndexDef[] = [
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
];

withTestLbugDB('rename-api-errors', (handle) => {
  describe('rename error handling via LocalBackend.callTool', () => {
    let backend: LocalBackend;
    let project: TempProject;

    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend; _project?: TempProject };
      backend = ext._backend!;
      project = ext._project!;
    });

    afterAll(async () => {
      const ext = handle as typeof handle & { _project?: TempProject };
      if (ext._project) await ext._project.cleanup();
    });

    it('returns error when symbol_name is missing for symbol rename', async () => {
      const result = await backend.callTool('rename', {
        new_name: 'newName',
        dry_run: true,
      });

      expect(result.error).toMatch(/symbol_name.*required/i);
    });

    it('returns ambiguous when multiple symbols match', async () => {
      const result = await backend.callTool('rename', {
        symbol_name: 'process',
        new_name: 'handle',
        dry_run: true,
      });

      // Should return ambiguous status with candidates
      expect(result.status).toBe('ambiguous');
      expect(result.candidates).toBeDefined();
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    });

    it('disambiguates with file_path parameter', async () => {
      const result = await backend.callTool('rename', {
        symbol_name: 'process',
        new_name: 'handle',
        file_path: 'src/a.ts',
        dry_run: true,
      });

      // With file_path, should find the specific symbol
      expect(result.status).toBe('success');
      expect(result.engine).toBe('ts_morph');
    });

    it('blocks path traversal in file rename', async () => {
      // Path traversal throws an error (caught by the caller), not returned as error object
      await expect(
        backend.callTool('rename', {
          type: 'file',
          symbol_name: '../../../etc/passwd',
          new_name: 'pwned.txt',
          dry_run: true,
        }),
      ).rejects.toThrow(/traversal/i);
    });
  });
}, {
  seed: ERROR_HANDLING_SEED,
  ftsIndexes: ERROR_HANDLING_FTS,
  poolAdapter: true,
  afterSetup: async (handle) => {
    // Create minimal files matching the seed
    const project = await createTempProject({
      'src/a.ts': `export function process() { return 1; }`,
      'src/b.ts': `export function process() { return 2; }`,
    });

    vi.mocked(listRegisteredRepos).mockResolvedValue([{
      name: 'test-repo',
      path: project.root,
      storagePath: handle.tmpHandle.dbPath,
      indexedAt: new Date().toISOString(),
      lastCommit: 'abc123',
      stats: { files: 2, nodes: 2, communities: 0, processes: 0 },
    }]);

    const backend = new LocalBackend();
    await backend.init();
    (handle as any)._backend = backend;
    (handle as any)._project = project;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Property vs Parameter disambiguation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * This test group verifies correct symbol disambiguation when:
 * - Same name exists as both a Property (interface member) and Parameter (function arg)
 * - UID lookup returns the exact requested symbol
 * - file_path scoping prioritizes by kind (Property > Parameter)
 */
const PROPERTY_PARAM_FILES = {
  'src/game/features/logistics/transport-job-record.ts': [
    'export interface TransportJobRecord {',                        // line 1
    '  sourceBuilding: string;',                                    // line 2 — Property, col 2
    '  destBuilding: string;',                                      // line 3 — Property, col 2
    '  quantity: number;',                                          // line 4
    '}',                                                            // line 5
    '',                                                             // line 6
    'export function createDeliveryOnlyRecord(',                    // line 7
    '  sourceBuilding: string,',                                    // line 8 — Parameter, col 2
    '  destBuilding: string,',                                      // line 9 — Parameter, col 2
    '): TransportJobRecord {',                                      // line 10
    '  return { sourceBuilding, destBuilding, quantity: 0 };',      // line 11
    '}',                                                            // line 12
  ].join('\n'),
};

// Seed: same name "destBuilding" as Property AND Parameter in same file
const PROPERTY_PARAM_SEED = [
  // Interface
  `CREATE (iface:Interface {id: 'Interface:src/game/features/logistics/transport-job-record.ts:TransportJobRecord', name: 'TransportJobRecord', filePath: 'src/game/features/logistics/transport-job-record.ts', startLine: 1, endLine: 5, startColumn: 17, isExported: true, content: '', description: ''})`,
  // Properties (interface members)
  `CREATE (p:Property {id: 'Property:src/game/features/logistics/transport-job-record.ts:TransportJobRecord.sourceBuilding', name: 'sourceBuilding', filePath: 'src/game/features/logistics/transport-job-record.ts', startLine: 2, endLine: 2, startColumn: 2, className: 'TransportJobRecord', content: 'sourceBuilding: string;', description: ''})`,
  `CREATE (p:Property {id: 'Property:src/game/features/logistics/transport-job-record.ts:TransportJobRecord.destBuilding', name: 'destBuilding', filePath: 'src/game/features/logistics/transport-job-record.ts', startLine: 3, endLine: 3, startColumn: 2, className: 'TransportJobRecord', content: 'destBuilding: string;', description: ''})`,
  // Function
  `CREATE (fn:Function {id: 'Function:src/game/features/logistics/transport-job-record.ts:createDeliveryOnlyRecord', name: 'createDeliveryOnlyRecord', filePath: 'src/game/features/logistics/transport-job-record.ts', startLine: 7, endLine: 12, startColumn: 17, isExported: true, content: '', description: ''})`,
  // Parameters (function args with SAME NAME as properties)
  `CREATE (p:Parameter {id: 'Parameter:src/game/features/logistics/transport-job-record.ts:createDeliveryOnlyRecord.sourceBuilding', name: 'sourceBuilding', filePath: 'src/game/features/logistics/transport-job-record.ts', startLine: 8, endLine: 8, startColumn: 2, ordinal: 0, isOptional: false, hasDefault: false, isRest: false, visibility: ''})`,
  `CREATE (p:Parameter {id: 'Parameter:src/game/features/logistics/transport-job-record.ts:createDeliveryOnlyRecord.destBuilding', name: 'destBuilding', filePath: 'src/game/features/logistics/transport-job-record.ts', startLine: 9, endLine: 9, startColumn: 2, ordinal: 1, isOptional: false, hasDefault: false, isRest: false, visibility: ''})`,
  // HAS_METHOD relationships
  `MATCH (iface:Interface {id: 'Interface:src/game/features/logistics/transport-job-record.ts:TransportJobRecord'}), (p:Property {id: 'Property:src/game/features/logistics/transport-job-record.ts:TransportJobRecord.sourceBuilding'})
   CREATE (iface)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'member', step: 0}]->(p)`,
  `MATCH (iface:Interface {id: 'Interface:src/game/features/logistics/transport-job-record.ts:TransportJobRecord'}), (p:Property {id: 'Property:src/game/features/logistics/transport-job-record.ts:TransportJobRecord.destBuilding'})
   CREATE (iface)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'member', step: 0}]->(p)`,
];

const PROPERTY_PARAM_FTS: FTSIndexDef[] = [
  { table: 'Property', indexName: 'property_fts', columns: ['name', 'content', 'description'] },
  { table: 'Parameter', indexName: 'parameter_fts', columns: ['name'] },
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
  { table: 'Interface', indexName: 'interface_fts', columns: ['name', 'content', 'description'] },
];

withTestLbugDB('rename-api-property-param-disambiguation', (handle) => {
  describe('Property vs Parameter disambiguation via LocalBackend.callTool', () => {
    let backend: LocalBackend;
    let project: TempProject;

    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend; _project?: TempProject };
      backend = ext._backend!;
      project = ext._project!;
    });

    afterAll(async () => {
      const ext = handle as typeof handle & { _project?: TempProject };
      if (ext._project) await ext._project.cleanup();
    });

    // --- Issue 1: UID lookup should find exact Property ---
    it('finds Property by exact UID (symbol_uid)', async () => {
      const result = await backend.callTool('context', {
        uid: 'Property:src/game/features/logistics/transport-job-record.ts:TransportJobRecord.destBuilding',
      });

      expect(result.status).toBe('found');
      expect(result.symbol.name).toBe('destBuilding');
      expect(result.symbol.kind).toBe('Property');
      expect(result.symbol.startLine).toBe(3);
      expect(result.symbol.startColumn).toBe(2);
    });

    // --- Issue 2: file_path should disambiguate to Property, not Parameter ---
    it('prefers Property over Parameter when both match file_path', async () => {
      const result = await backend.callTool('context', {
        name: 'destBuilding',
        file_path: 'transport-job-record.ts',
      });

      expect(result.status).toBe('found');
      expect(result.symbol.kind).toBe('Property');
      expect(result.symbol.startLine).toBe(3); // Property line, not Parameter line 9
    });

    // --- Issue 3: name-only lookup should return Property (higher priority) ---
    it('prefers Property over Parameter when searching by name only', async () => {
      // This is ambiguous (multiple matches), but should return Property first
      const result = await backend.callTool('context', {
        name: 'destBuilding',
      });

      // Should return ambiguous since both Property and Parameter exist with same name
      // But the first candidate should be the Property (higher priority)
      if (result.status === 'ambiguous') {
        expect(result.candidates[0].kind).toBe('Property');
        expect(result.candidates[0].line).toBe(3);
      } else if (result.status === 'found') {
        // If only one is returned, it should be the Property
        expect(result.symbol.kind).toBe('Property');
      }
    });

    // --- Issue 4: startColumn should be included in result ---
    it('includes startColumn in symbol result for ts-morph rename precision', async () => {
      const result = await backend.callTool('context', {
        uid: 'Property:src/game/features/logistics/transport-job-record.ts:TransportJobRecord.destBuilding',
      });

      expect(result.status).toBe('found');
      expect(result.symbol.startColumn).toBeDefined();
      expect(result.symbol.startColumn).toBe(2);
    });

    // --- Issue 5: Dotted syntax should find interface property ---
    it('finds Property via dotted syntax TransportJobRecord.destBuilding', async () => {
      const result = await backend.callTool('context', {
        name: 'TransportJobRecord.destBuilding',
      });

      expect(result.status).toBe('found');
      expect(result.symbol.name).toBe('destBuilding');
      expect(result.symbol.kind).toBe('Property');
      expect(result.symbol.startLine).toBe(3);
    });

    // --- Rename via dotted syntax should find the Property ---
    it('renames Property via dotted syntax TransportJobRecord.destBuilding', async () => {
      const result = await backend.callTool('rename', {
        symbol_name: 'TransportJobRecord.destBuilding',
        new_name: 'destBuildingRef',
        dry_run: true,
      });

      expect(result.status).toBe('success');
      expect(result.old_name).toBe('destBuilding');
      expect(result.new_name).toBe('destBuildingRef');
      expect(result.engine).toBe('ts_morph');
    });

    // --- Rename should work via UID (bypassing ambiguity) ---
    it('renames Property via UID (bypassing Parameter with same name)', async () => {
      const result = await backend.callTool('rename', {
        symbol_uid: 'Property:src/game/features/logistics/transport-job-record.ts:TransportJobRecord.destBuilding',
        new_name: 'destBuildingId',
        dry_run: true,
      });

      expect(result.status).toBe('success');
      expect(result.old_name).toBe('destBuilding');
      expect(result.new_name).toBe('destBuildingId');
      expect(result.engine).toBe('ts_morph');
      // Should have edits on both lines 3 (Property def) and 11 (shorthand usage)
      expect(result.total_edits).toBeGreaterThanOrEqual(2);
    });

    // --- Rename with file_path should select Property, not Parameter ---
    it('renames Property when file_path disambiguation selects Property over Parameter', async () => {
      const result = await backend.callTool('rename', {
        symbol_name: 'sourceBuilding',
        file_path: 'transport-job-record.ts',
        new_name: 'sourceBuildingId',
        dry_run: true,
      });

      expect(result.status).toBe('success');
      expect(result.old_name).toBe('sourceBuilding');
      expect(result.new_name).toBe('sourceBuildingId');
      expect(result.engine).toBe('ts_morph');
      // Edits should target Property line 2, not Parameter line 8
      const edit = result.changes?.find((c: any) => c.edits.some((e: any) => e.line === 2));
      expect(edit).toBeDefined();
    });
  });
}, {
  seed: PROPERTY_PARAM_SEED,
  ftsIndexes: PROPERTY_PARAM_FTS,
  poolAdapter: true,
  afterSetup: async (handle) => {
    const project = await createTempProject(PROPERTY_PARAM_FILES);

    vi.mocked(listRegisteredRepos).mockResolvedValue([{
      name: 'test-repo',
      path: project.root,
      storagePath: handle.tmpHandle.dbPath,
      indexedAt: new Date().toISOString(),
      lastCommit: 'abc123',
      stats: { files: 1, nodes: 6, communities: 0, processes: 0 },
    }]);

    const backend = new LocalBackend();
    await backend.init();
    (handle as any)._backend = backend;
    (handle as any)._project = project;
  },
});
