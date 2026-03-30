/**
 * Integration Tests: single-file rename/move
 *
 * Tests the file (single-file move) rename feature against real filesystem
 * TS projects. Each test creates a temp directory with source files and a
 * tsconfig, then verifies that fileRename correctly moves the file and
 * updates all import/export paths using ts-morph's SourceFile.move() API.
 *
 * Categories:
 * 1. Basic file move (dry run, apply, response format)
 * 2. Import path updates (consumers update their imports)
 * 3. Moved file's own imports (outward imports adjusted)
 * 4. Non-TS file move
 * 5. JavaScript files (.js, .jsx)
 * 6. Barrel file / re-export updates
 * 7. Type-only imports
 * 8. Cross-depth move (move to deeper/shallower location)
 * 9. Rename within same directory (just rename the file)
 * 10. Target directory auto-creation
 * 11. Error handling (missing file, target exists, not a file)
 * 12. Empty parent directory cleanup
 * 13. Multiple consumers at different depths
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileRename, type FileRenameResult } from '../../src/core/rename/file-rename.js';

// ─── Helpers ────────────────────────────────────────────────────────────

interface TempProject {
  root: string;
  cleanup: () => Promise<void>;
}

/** Create a temp directory with files and a tsconfig.json. */
async function createTempProject(
  files: Record<string, string>,
): Promise<TempProject> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-rename-'));

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

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  return {
    root,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); },
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

/** Shorthand to run a file rename and assert it produced results. */
async function renameAndAssert(
  project: TempProject,
  opts: { oldFile: string; newFile: string; dryRun?: boolean },
): Promise<FileRenameResult> {
  const result = await fileRename({
    repoPath: project.root,
    oldFile: opts.oldFile,
    newFile: opts.newFile,
    dryRun: opts.dryRun ?? false,
  });
  expect(result.files_moved.length).toBe(1);
  expect(result.files_moved[0].from).toBe(opts.oldFile);
  expect(result.files_moved[0].to).toBe(opts.newFile);
  for (const edit of result.edits) {
    expect(edit.confidence).toBe('ts_morph');
    expect(edit.line).toBeGreaterThan(0);
    expect(edit.filePath).toBeTruthy();
  }
  return result;
}

// ─── fileRename ───────────────────────────────────────────────────────

describe('fileRename', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Basic file move
  // ═══════════════════════════════════════════════════════════════════════

  describe('basic file move', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/utils/helpers.ts': [
          'export function helper() { return 42; }',
        ].join('\n'),
        'src/app.ts': [
          'import { helper } from "./utils/helpers";',
          '',
          'console.log(helper());',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('previews file move and import edits in dry run without modifying files', async () => {
      const result = await renameAndAssert(project, {
        oldFile: 'src/utils/helpers.ts',
        newFile: 'src/lib/helpers.ts',
        dryRun: true,
      });

      // Import edits in app.ts
      const appEdits = result.edits.filter(e => e.filePath === 'src/app.ts');
      expect(appEdits.length).toBeGreaterThanOrEqual(1);
      const hasUpdate = appEdits.some(
        e => e.old_text.includes('./utils/helpers') && e.new_text.includes('./lib/helpers'),
      );
      expect(hasUpdate).toBe(true);

      // Dry run must NOT modify files
      expect(await fileExists(project, 'src/utils/helpers.ts')).toBe(true);
      expect(await fileExists(project, 'src/lib/helpers.ts')).toBe(false);
      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./utils/helpers');
    });

    it('applies move and updates imports when dryRun is false', async () => {
      const result = await renameAndAssert(project, {
        oldFile: 'src/utils/helpers.ts',
        newFile: 'src/lib/helpers.ts',
      });

      // Old file should be gone
      expect(await fileExists(project, 'src/utils/helpers.ts')).toBe(false);

      // New file should exist with correct content
      expect(await fileExists(project, 'src/lib/helpers.ts')).toBe(true);
      const helperContent = await readFile(project, 'src/lib/helpers.ts');
      expect(helperContent).toContain('export function helper');

      // Import paths in app.ts should be updated
      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./lib/helpers');
      expect(appContent).not.toContain('./utils/helpers');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Consumer import updates across the codebase
  // ═══════════════════════════════════════════════════════════════════════

  describe('consumer import updates', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/core/auth.ts': [
          'export function authenticate() { return true; }',
        ].join('\n'),
        'src/routes/login.ts': [
          'import { authenticate } from "../core/auth";',
          '',
          'export function login() { return authenticate(); }',
        ].join('\n'),
        'src/routes/api/protected.ts': [
          'import { authenticate } from "../../core/auth";',
          '',
          'export function protect() { return authenticate(); }',
        ].join('\n'),
        'src/index.ts': [
          'export { authenticate } from "./core/auth";',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates imports in multiple consumers at different depths', async () => {
      await renameAndAssert(project, {
        oldFile: 'src/core/auth.ts',
        newFile: 'src/services/auth.ts',
      });

      const loginContent = await readFile(project, 'src/routes/login.ts');
      expect(loginContent).toContain('../services/auth');
      expect(loginContent).not.toContain('../core/auth');

      const protectedContent = await readFile(project, 'src/routes/api/protected.ts');
      expect(protectedContent).toContain('../../services/auth');
      expect(protectedContent).not.toContain('../../core/auth');

      const indexContent = await readFile(project, 'src/index.ts');
      expect(indexContent).toContain('./services/auth');
      expect(indexContent).not.toContain('./core/auth');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Moved file's own outward imports
  // ═══════════════════════════════════════════════════════════════════════

  describe('moved file outward imports', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/shared/constants.ts': [
          'export const MAX = 100;',
        ].join('\n'),
        'src/shared/types.ts': [
          'export interface Config { max: number; }',
        ].join('\n'),
        'src/utils/processor.ts': [
          'import { MAX } from "../shared/constants";',
          'import type { Config } from "../shared/types";',
          '',
          'export function process(cfg: Config) {',
          '  return cfg.max <= MAX;',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('adjusts outward imports when moved to a deeper location', async () => {
      await renameAndAssert(project, {
        oldFile: 'src/utils/processor.ts',
        newFile: 'src/deep/nested/processor.ts',
      });

      const content = await readFile(project, 'src/deep/nested/processor.ts');
      expect(content).toContain('from "../../shared/constants"');
      expect(content).toContain('from "../../shared/types"');
      expect(content).not.toContain('"../shared/');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Non-TS file move
  // ═══════════════════════════════════════════════════════════════════════

  describe('non-TS file move', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/styles/main.css': '.app { display: flex; }',
        'assets/logo.svg': '<svg>logo</svg>',
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('moves CSS file via filesystem with no edits', async () => {
      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'src/styles/main.css',
        newFile: 'src/css/main.css',
        dryRun: false,
      });

      expect(result.files_moved.length).toBe(1);
      expect(result.edits.length).toBe(0);

      expect(await fileExists(project, 'src/css/main.css')).toBe(true);
      expect(await fileExists(project, 'src/styles/main.css')).toBe(false);

      const content = await readFile(project, 'src/css/main.css');
      expect(content).toBe('.app { display: flex; }');
    });

    it('moves SVG file via filesystem', async () => {
      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'assets/logo.svg',
        newFile: 'public/images/logo.svg',
        dryRun: false,
      });

      expect(result.files_moved.length).toBe(1);
      expect(result.edits.length).toBe(0);

      expect(await fileExists(project, 'public/images/logo.svg')).toBe(true);
      expect(await fileExists(project, 'assets/logo.svg')).toBe(false);

      const content = await readFile(project, 'public/images/logo.svg');
      expect(content).toBe('<svg>logo</svg>');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. JavaScript files (.js, .jsx)
  // ═══════════════════════════════════════════════════════════════════════

  describe('JavaScript files', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/utils/format.js': [
          'export function format(val) { return String(val); }',
        ].join('\n'),
        'src/components/Display.jsx': [
          'import { format } from "../utils/format";',
          '',
          'export function Display({ value }) {',
          '  return format(value);',
          '}',
        ].join('\n'),
        'src/app.js': [
          'import { format } from "./utils/format";',
          'import { Display } from "./components/Display";',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('moves .js file and updates .js and .jsx consumers', async () => {
      await renameAndAssert(project, {
        oldFile: 'src/utils/format.js',
        newFile: 'src/lib/format.js',
      });

      expect(await fileExists(project, 'src/lib/format.js')).toBe(true);
      expect(await fileExists(project, 'src/utils/format.js')).toBe(false);

      const displayContent = await readFile(project, 'src/components/Display.jsx');
      expect(displayContent).toContain('../lib/format');
      expect(displayContent).not.toContain('../utils/format');

      const appContent = await readFile(project, 'src/app.js');
      expect(appContent).toContain('./lib/format');
      expect(appContent).not.toContain('./utils/format');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Barrel file / re-export updates
  // ═══════════════════════════════════════════════════════════════════════

  describe('barrel file and re-exports', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/utils/validate.ts': [
          'export function validate(input: string) { return input.length > 0; }',
        ].join('\n'),
        'src/utils/index.ts': [
          'export { validate } from "./validate";',
        ].join('\n'),
        'src/app.ts': [
          'import { validate } from "./utils";',
          'validate("test");',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates barrel re-export when underlying file moves', async () => {
      await renameAndAssert(project, {
        oldFile: 'src/utils/validate.ts',
        newFile: 'src/validators/validate.ts',
      });

      // The barrel file's re-export should be updated
      const indexContent = await readFile(project, 'src/utils/index.ts');
      expect(indexContent).toContain('../validators/validate');
      expect(indexContent).not.toContain('./validate');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Type-only imports
  // ═══════════════════════════════════════════════════════════════════════

  describe('type-only imports', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/types/user.ts': [
          'export interface User { id: string; name: string; }',
          'export type UserId = string;',
        ].join('\n'),
        'src/services/user-service.ts': [
          'import type { User } from "../types/user";',
          'import { type UserId } from "../types/user";',
          '',
          'export function getUser(id: UserId): User {',
          '  return { id, name: "test" };',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates type-only import paths', async () => {
      await renameAndAssert(project, {
        oldFile: 'src/types/user.ts',
        newFile: 'src/models/user.ts',
      });

      const serviceContent = await readFile(project, 'src/services/user-service.ts');
      expect(serviceContent).toContain('../models/user');
      expect(serviceContent).not.toContain('../types/user');
      // Type import syntax preserved
      expect(serviceContent).toContain('import type {');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Cross-depth move (shallower)
  // ═══════════════════════════════════════════════════════════════════════

  describe('move to shallower location', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/features/auth/middleware/guard.ts': [
          'export function guard() { return true; }',
        ].join('\n'),
        'src/app.ts': [
          'import { guard } from "./features/auth/middleware/guard";',
          'guard();',
        ].join('\n'),
        'src/features/auth/login.ts': [
          'import { guard } from "./middleware/guard";',
          'guard();',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates all imports when moving to a shallower path', async () => {
      await renameAndAssert(project, {
        oldFile: 'src/features/auth/middleware/guard.ts',
        newFile: 'src/middleware/guard.ts',
      });

      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./middleware/guard');
      expect(appContent).not.toContain('./features/');

      const loginContent = await readFile(project, 'src/features/auth/login.ts');
      expect(loginContent).toContain('../../middleware/guard');
      expect(loginContent).not.toContain('"./middleware/guard"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Rename within same directory
  // ═══════════════════════════════════════════════════════════════════════

  describe('rename within same directory', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/utils/old-name.ts': [
          'export function doStuff() { return "stuff"; }',
        ].join('\n'),
        'src/app.ts': [
          'import { doStuff } from "./utils/old-name";',
          'doStuff();',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames file in place and updates imports', async () => {
      await renameAndAssert(project, {
        oldFile: 'src/utils/old-name.ts',
        newFile: 'src/utils/new-name.ts',
      });

      expect(await fileExists(project, 'src/utils/new-name.ts')).toBe(true);
      expect(await fileExists(project, 'src/utils/old-name.ts')).toBe(false);

      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./utils/new-name');
      expect(appContent).not.toContain('./utils/old-name');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. Target directory auto-creation
  // ═══════════════════════════════════════════════════════════════════════

  describe('auto-creates target directory', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/old.ts': 'export const x = 1;',
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('creates intermediate directories when moving non-TS files', async () => {
      // Add a non-TS file for this test
      await fs.writeFile(path.join(project.root, 'data.json'), '{"key": "val"}');

      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'data.json',
        newFile: 'config/data/data.json',
        dryRun: false,
      });

      expect(await fileExists(project, 'config/data/data.json')).toBe(true);
      expect(await fileExists(project, 'data.json')).toBe(false);

      const content = await readFile(project, 'config/data/data.json');
      expect(content).toBe('{"key": "val"}');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. Error handling
  // ═══════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/a.ts': 'export const a = 1;',
        'src/b.ts': 'export const b = 2;',
        'src/dir/c.ts': 'export const c = 3;',
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('throws when source file does not exist', async () => {
      await expect(
        fileRename({
          repoPath: project.root,
          oldFile: 'src/nonexistent.ts',
          newFile: 'src/dest.ts',
          dryRun: true,
        }),
      ).rejects.toThrow();
    });

    it('throws when target file already exists', async () => {
      await expect(
        fileRename({
          repoPath: project.root,
          oldFile: 'src/a.ts',
          newFile: 'src/b.ts',
          dryRun: true,
        }),
      ).rejects.toThrow('already exists');
    });

    it('throws when source path is a directory', async () => {
      await expect(
        fileRename({
          repoPath: project.root,
          oldFile: 'src/dir',
          newFile: 'src/other',
          dryRun: true,
        }),
      ).rejects.toThrow('not a file');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. Empty parent directory cleanup
  // ═══════════════════════════════════════════════════════════════════════

  describe('empty parent cleanup', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/deep/nested/only-file.ts': [
          'export const value = 1;',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('removes empty parent directories after move', async () => {
      await renameAndAssert(project, {
        oldFile: 'src/deep/nested/only-file.ts',
        newFile: 'src/flat/only-file.ts',
      });

      expect(await fileExists(project, 'src/flat/only-file.ts')).toBe(true);
      // Empty parent dirs should be cleaned up
      expect(await dirExists(project, 'src/deep/nested')).toBe(false);
      expect(await dirExists(project, 'src/deep')).toBe(false);
      // src/ should still exist (has other content — tsconfig is at root)
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 13. Multiple consumers at different depths
  // ═══════════════════════════════════════════════════════════════════════

  describe('consumers at different depths', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/lib/api.ts': [
          'export function fetchData() { return "data"; }',
        ].join('\n'),
        'src/consumer.ts': [
          'import { fetchData } from "./lib/api";',
          'fetchData();',
        ].join('\n'),
        'src/a/consumer.ts': [
          'import { fetchData } from "../lib/api";',
          'fetchData();',
        ].join('\n'),
        'src/a/b/consumer.ts': [
          'import { fetchData } from "../../lib/api";',
          'fetchData();',
        ].join('\n'),
        'src/a/b/c/consumer.ts': [
          'import { fetchData } from "../../../lib/api";',
          'fetchData();',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates imports at all depths correctly', async () => {
      await renameAndAssert(project, {
        oldFile: 'src/lib/api.ts',
        newFile: 'src/services/api.ts',
      });

      const rootContent = await readFile(project, 'src/consumer.ts');
      expect(rootContent).toContain('./services/api');

      const aContent = await readFile(project, 'src/a/consumer.ts');
      expect(aContent).toContain('../services/api');

      const bContent = await readFile(project, 'src/a/b/consumer.ts');
      expect(bContent).toContain('../../services/api');

      const cContent = await readFile(project, 'src/a/b/c/consumer.ts');
      expect(cContent).toContain('../../../services/api');

      // None should reference old path
      for (const content of [rootContent, aContent, bContent, cContent]) {
        expect(content).not.toContain('/lib/api');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14. Edit format and confidence
  // ═══════════════════════════════════════════════════════════════════════

  describe('edit format', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/mod.ts': 'export const value = 1;',
        'src/consumer.ts': [
          'import { value } from "./mod";',
          'console.log(value);',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('produces edits with correct structure', async () => {
      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'src/mod.ts',
        newFile: 'src/lib/mod.ts',
        dryRun: true,
      });

      const consumerEdits = result.edits.filter(e => e.filePath === 'src/consumer.ts');
      expect(consumerEdits.length).toBeGreaterThanOrEqual(1);

      for (const edit of consumerEdits) {
        expect(edit).toHaveProperty('filePath');
        expect(edit).toHaveProperty('line');
        expect(edit).toHaveProperty('old_text');
        expect(edit).toHaveProperty('new_text');
        expect(edit).toHaveProperty('confidence');
        expect(edit.confidence).toBe('ts_morph');
        expect(typeof edit.line).toBe('number');
        expect(edit.old_text).not.toBe(edit.new_text);
      }

      // Move entry
      expect(result.files_moved.length).toBe(1);
      expect(result.files_moved[0].from).toBe('src/mod.ts');
      expect(result.files_moved[0].to).toBe('src/lib/mod.ts');
    });
  });
});
