/**
 * Integration Tests: directory rename
 *
 * Tests the directory (module path) rename feature against real filesystem
 * TS projects. Each test creates a temp directory with source files and a
 * tsconfig, then verifies that directoryRename correctly moves files and
 * updates all import/export paths using ts-morph's SourceFile.move() API.
 *
 * Categories:
 * 1. Basic directory move (dry run, apply, response format)
 * 2. Import path updates (relative, deep, cross-directory)
 * 3. Internal imports (within moved directory)
 * 4. Non-TS files (CSS, JSON, assets)
 * 5. Nested directories
 * 6. Re-exports and barrel files
 * 7. Error handling (missing dir, target exists, path traversal)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { directoryRename, type DirectoryRenameResult } from '../../src/core/rename/directory-rename.js';

// ─── Helpers ────────────────────────────────────────────────────────────

interface TempProject {
  root: string;
  cleanup: () => Promise<void>;
}

/** Create a temp directory with files and a tsconfig.json. */
async function createTempProject(
  files: Record<string, string>,
  tsConfigOverrides?: Record<string, unknown>,
): Promise<TempProject> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dir-rename-'));

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

/** Shorthand to run a directory rename and assert it produced results. */
async function renameAndAssert(
  project: TempProject,
  opts: { oldDir: string; newDir: string; dryRun?: boolean },
): Promise<DirectoryRenameResult> {
  const result = await directoryRename({
    repoPath: project.root,
    oldDir: opts.oldDir,
    newDir: opts.newDir,
    dryRun: opts.dryRun ?? false,
  });
  expect(result.files_moved.length).toBeGreaterThan(0);
  for (const edit of result.edits) {
    expect(edit.confidence).toBe('ts_morph');
    expect(edit.line).toBeGreaterThan(0);
    expect(edit.filePath).toBeTruthy();
  }
  return result;
}

// ─── directoryRename ───────────────────────────────────────────────────

describe('directoryRename', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Basic directory move
  // ═══════════════════════════════════════════════════════════════════════

  describe('basic directory move', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/renderer.ts': [
          'export function render(ctx: string): void {',
          '  console.log("rendering", ctx);',
          '}',
        ].join('\n'),
        'src/canvas/types.ts': [
          'export interface CanvasConfig {',
          '  width: number;',
          '  height: number;',
          '}',
        ].join('\n'),
        'src/app.ts': [
          'import { render } from "./canvas/renderer";',
          'import { CanvasConfig } from "./canvas/types";',
          '',
          'const cfg: CanvasConfig = { width: 800, height: 600 };',
          'render("main");',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('previews file moves and import edits in dry run without modifying files', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
        dryRun: true,
      });

      // Both files should be listed as moved
      expect(result.files_moved.length).toBe(2);
      const movedFromPaths = result.files_moved.map(m => m.from);
      expect(movedFromPaths).toContain('src/canvas/renderer.ts');
      expect(movedFromPaths).toContain('src/canvas/types.ts');

      const movedToPaths = result.files_moved.map(m => m.to);
      expect(movedToPaths).toContain('src/view/renderer.ts');
      expect(movedToPaths).toContain('src/view/types.ts');

      // Import edits in app.ts
      const appEdits = result.edits.filter(e => e.filePath === 'src/app.ts');
      expect(appEdits.length).toBeGreaterThanOrEqual(1);
      const hasCanvasToView = appEdits.some(
        e => e.old_text.includes('./canvas/') && e.new_text.includes('./view/'),
      );
      expect(hasCanvasToView).toBe(true);

      // Dry run must NOT modify files
      expect(await fileExists(project, 'src/canvas/renderer.ts')).toBe(true);
      expect(await fileExists(project, 'src/view/renderer.ts')).toBe(false);
      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./canvas/renderer');
    });

    it('applies move and updates imports when dryRun is false', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
      });

      expect(result.files_moved.length).toBe(2);

      // Old files should be gone
      expect(await fileExists(project, 'src/canvas/renderer.ts')).toBe(false);
      expect(await fileExists(project, 'src/canvas/types.ts')).toBe(false);

      // New files should exist with correct content
      expect(await fileExists(project, 'src/view/renderer.ts')).toBe(true);
      expect(await fileExists(project, 'src/view/types.ts')).toBe(true);

      const rendererContent = await readFile(project, 'src/view/renderer.ts');
      expect(rendererContent).toContain('export function render');

      // Import paths in app.ts should be updated
      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./view/renderer');
      expect(appContent).toContain('./view/types');
      expect(appContent).not.toContain('./canvas/');

      // Old directory should be cleaned up
      expect(await dirExists(project, 'src/canvas')).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Import path updates across the codebase
  // ═══════════════════════════════════════════════════════════════════════

  describe('cross-directory import updates', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/shell.ts': [
          'export class Shell {',
          '  run() { return "shell"; }',
          '}',
        ].join('\n'),
        'src/canvas/utils.ts': [
          'export function canvasHelper() { return 42; }',
        ].join('\n'),
        'src/engine/core.ts': [
          'import { Shell } from "../canvas/shell";',
          'import { canvasHelper } from "../canvas/utils";',
          '',
          'export function init() {',
          '  const s = new Shell();',
          '  return canvasHelper();',
          '}',
        ].join('\n'),
        'src/tests/shell.test.ts': [
          'import { Shell } from "../canvas/shell";',
          '',
          'const s = new Shell();',
        ].join('\n'),
        'src/index.ts': [
          'export { Shell } from "./canvas/shell";',
          'export { canvasHelper } from "./canvas/utils";',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates imports in multiple directories and re-exports', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
      });

      // engine/core.ts — sibling directory
      const coreContent = await readFile(project, 'src/engine/core.ts');
      expect(coreContent).toContain('../view/shell');
      expect(coreContent).toContain('../view/utils');
      expect(coreContent).not.toContain('../canvas/');

      // tests/shell.test.ts — another sibling directory
      const testContent = await readFile(project, 'src/tests/shell.test.ts');
      expect(testContent).toContain('../view/shell');
      expect(testContent).not.toContain('../canvas/');

      // index.ts — re-exports
      const indexContent = await readFile(project, 'src/index.ts');
      expect(indexContent).toContain('./view/shell');
      expect(indexContent).toContain('./view/utils');
      expect(indexContent).not.toContain('./canvas/');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Internal imports within moved directory
  // ═══════════════════════════════════════════════════════════════════════

  describe('internal imports within moved directory', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/types.ts': [
          'export interface Shape { x: number; y: number; }',
        ].join('\n'),
        'src/canvas/renderer.ts': [
          'import { Shape } from "./types";',
          '',
          'export function draw(shape: Shape): void {',
          '  console.log(shape.x, shape.y);',
          '}',
        ].join('\n'),
        'src/canvas/index.ts': [
          'export { Shape } from "./types";',
          'export { draw } from "./renderer";',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('preserves relative imports between files within the same moved directory', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
      });

      // Files should be in new location
      expect(await fileExists(project, 'src/view/types.ts')).toBe(true);
      expect(await fileExists(project, 'src/view/renderer.ts')).toBe(true);
      expect(await fileExists(project, 'src/view/index.ts')).toBe(true);

      // Internal relative imports should stay the same (./types, ./renderer)
      const rendererContent = await readFile(project, 'src/view/renderer.ts');
      expect(rendererContent).toContain('from "./types"');

      const indexContent = await readFile(project, 'src/view/index.ts');
      expect(indexContent).toContain('from "./types"');
      expect(indexContent).toContain('from "./renderer"');

      // Internal imports should not produce edits (they don't change)
      const internalEdits = result.edits.filter(
        e => e.filePath.startsWith('src/view/') &&
             e.old_text.includes('./types') &&
             e.new_text.includes('./types'),
      );
      expect(internalEdits.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Non-TypeScript files
  // ═══════════════════════════════════════════════════════════════════════

  describe('non-TypeScript files', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/component.ts': [
          'export function component() { return "canvas"; }',
        ].join('\n'),
        'src/canvas/styles.css': [
          '.canvas { display: flex; }',
        ].join('\n'),
        'src/canvas/config.json': [
          '{ "name": "canvas" }',
        ].join('\n'),
        'src/canvas/README.md': [
          '# Canvas module',
        ].join('\n'),
        'src/app.ts': [
          'import { component } from "./canvas/component";',
          'component();',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('moves non-TS files alongside TS files', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
      });

      // All files should be moved
      expect(result.files_moved.length).toBe(4);
      const movedToPaths = result.files_moved.map(m => m.to);
      expect(movedToPaths).toContain('src/view/component.ts');
      expect(movedToPaths).toContain('src/view/styles.css');
      expect(movedToPaths).toContain('src/view/config.json');
      expect(movedToPaths).toContain('src/view/README.md');

      // Non-TS files should exist at new location with same content
      expect(await fileExists(project, 'src/view/styles.css')).toBe(true);
      expect(await fileExists(project, 'src/view/config.json')).toBe(true);
      expect(await fileExists(project, 'src/view/README.md')).toBe(true);

      const cssContent = await readFile(project, 'src/view/styles.css');
      expect(cssContent).toContain('.canvas { display: flex; }');

      const jsonContent = await readFile(project, 'src/view/config.json');
      expect(jsonContent).toContain('"canvas"');

      // Old files should be gone
      expect(await fileExists(project, 'src/canvas/styles.css')).toBe(false);
      expect(await fileExists(project, 'src/canvas/config.json')).toBe(false);

      // TS imports should still be updated
      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./view/component');
      expect(appContent).not.toContain('./canvas/');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Nested directories
  // ═══════════════════════════════════════════════════════════════════════

  describe('nested directory structure', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/core/engine.ts': [
          'export class Engine {',
          '  start() { return "engine"; }',
          '}',
        ].join('\n'),
        'src/canvas/core/pipeline.ts': [
          'import { Engine } from "./engine";',
          '',
          'export function createPipeline() {',
          '  return new Engine();',
          '}',
        ].join('\n'),
        'src/canvas/ui/toolbar.ts': [
          'import { Engine } from "../core/engine";',
          '',
          'export function toolbar(e: Engine) {',
          '  e.start();',
          '}',
        ].join('\n'),
        'src/app.ts': [
          'import { Engine } from "./canvas/core/engine";',
          'import { createPipeline } from "./canvas/core/pipeline";',
          'import { toolbar } from "./canvas/ui/toolbar";',
          '',
          'const e = new Engine();',
          'createPipeline();',
          'toolbar(e);',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('moves nested subdirectories and updates deep import paths', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
      });

      // All 3 files moved
      expect(result.files_moved.length).toBe(3);

      // Nested files exist at new location
      expect(await fileExists(project, 'src/view/core/engine.ts')).toBe(true);
      expect(await fileExists(project, 'src/view/core/pipeline.ts')).toBe(true);
      expect(await fileExists(project, 'src/view/ui/toolbar.ts')).toBe(true);

      // Old nested dirs cleaned up
      expect(await dirExists(project, 'src/canvas')).toBe(false);

      // Internal imports preserved (same relative structure)
      const pipelineContent = await readFile(project, 'src/view/core/pipeline.ts');
      expect(pipelineContent).toContain('from "./engine"');

      // Cross-subdirectory import preserved
      const toolbarContent = await readFile(project, 'src/view/ui/toolbar.ts');
      expect(toolbarContent).toContain('from "../core/engine"');

      // External imports updated
      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./view/core/engine');
      expect(appContent).toContain('./view/core/pipeline');
      expect(appContent).toContain('./view/ui/toolbar');
      expect(appContent).not.toContain('./canvas/');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Re-exports and barrel files
  // ═══════════════════════════════════════════════════════════════════════

  describe('barrel file and re-exports', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/draw.ts': [
          'export function drawCircle() { return "circle"; }',
          'export function drawRect() { return "rect"; }',
        ].join('\n'),
        'src/canvas/index.ts': [
          'export { drawCircle, drawRect } from "./draw";',
        ].join('\n'),
        'src/main.ts': [
          'import { drawCircle } from "./canvas";',
          'import { drawRect } from "./canvas/draw";',
          '',
          'drawCircle();',
          'drawRect();',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates barrel imports and direct submodule imports', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
      });

      const mainContent = await readFile(project, 'src/main.ts');
      // Barrel import: "./canvas" → "./view"
      expect(mainContent).toContain('./view');
      expect(mainContent).not.toContain('./canvas');

      // Barrel file moved and internal export preserved
      const indexContent = await readFile(project, 'src/view/index.ts');
      expect(indexContent).toContain('from "./draw"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Mixed imports: some from moved dir, some from elsewhere
  // ═══════════════════════════════════════════════════════════════════════

  describe('mixed imports in consumer file', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/widget.ts': [
          'export class Widget { name = "widget"; }',
        ].join('\n'),
        'src/utils/logger.ts': [
          'export function log(msg: string) { console.log(msg); }',
        ].join('\n'),
        'src/app.ts': [
          'import { Widget } from "./canvas/widget";',
          'import { log } from "./utils/logger";',
          '',
          'const w = new Widget();',
          'log(w.name);',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('only updates imports from the moved directory, leaves others untouched', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
      });

      const appContent = await readFile(project, 'src/app.ts');
      // Canvas import updated
      expect(appContent).toContain('./view/widget');
      expect(appContent).not.toContain('./canvas/');
      // Utils import untouched
      expect(appContent).toContain('./utils/logger');

      // Utils file untouched
      const loggerContent = await readFile(project, 'src/utils/logger.ts');
      expect(loggerContent).toContain('export function log');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Imports from outside into moved directory (files that import out)
  // ═══════════════════════════════════════════════════════════════════════

  describe('moved files importing from outside the directory', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/shared/constants.ts': [
          'export const MAX_SIZE = 1024;',
        ].join('\n'),
        'src/canvas/renderer.ts': [
          'import { MAX_SIZE } from "../shared/constants";',
          '',
          'export function render() {',
          '  return MAX_SIZE;',
          '}',
        ].join('\n'),
        'src/app.ts': [
          'import { render } from "./canvas/renderer";',
          'render();',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates outward imports from moved files when relative path changes', async () => {
      // Moving src/canvas → src/deep/nested/view changes the relative path
      // from the moved file to ../shared/constants
      const result = await directoryRename({
        repoPath: project.root,
        oldDir: 'src/canvas',
        newDir: 'src/deep/nested/view',
        dryRun: false,
      });

      expect(result.files_moved.length).toBe(1);

      // The moved file's import to shared/constants must be updated
      const rendererContent = await readFile(project, 'src/deep/nested/view/renderer.ts');
      expect(rendererContent).toContain('from "../../../shared/constants"');
      expect(rendererContent).not.toContain('"../shared/constants"');

      // External import to the moved file also updated
      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('./deep/nested/view/renderer');
      expect(appContent).not.toContain('./canvas/');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. JavaScript files (.js, .jsx)
  // ═══════════════════════════════════════════════════════════════════════

  describe('JavaScript files', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/helper.js': [
          'export function helper() { return "help"; }',
        ].join('\n'),
        'src/canvas/component.jsx': [
          'import { helper } from "./helper";',
          '',
          'export function Component() {',
          '  return helper();',
          '}',
        ].join('\n'),
        'src/app.js': [
          'import { helper } from "./canvas/helper";',
          'import { Component } from "./canvas/component";',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('handles .js and .jsx files via ts-morph', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
      });

      expect(result.files_moved.length).toBe(2);

      expect(await fileExists(project, 'src/view/helper.js')).toBe(true);
      expect(await fileExists(project, 'src/view/component.jsx')).toBe(true);

      const appContent = await readFile(project, 'src/app.js');
      expect(appContent).toContain('./view/helper');
      expect(appContent).toContain('./view/component');
      expect(appContent).not.toContain('./canvas/');

      // Internal import preserved
      const componentContent = await readFile(project, 'src/view/component.jsx');
      expect(componentContent).toContain('from "./helper"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. Edit format and confidence
  // ═══════════════════════════════════════════════════════════════════════

  describe('edit format', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/mod.ts': [
          'export const value = 1;',
        ].join('\n'),
        'src/consumer.ts': [
          'import { value } from "./canvas/mod";',
          'console.log(value);',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('produces edits with correct structure', async () => {
      const result = await directoryRename({
        repoPath: project.root,
        oldDir: 'src/canvas',
        newDir: 'src/view',
        dryRun: true,
      });

      // Consumer file should have an import-path edit
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

      // Moves should have from/to
      for (const move of result.files_moved) {
        expect(move).toHaveProperty('from');
        expect(move).toHaveProperty('to');
        expect(move.from).toContain('src/canvas/');
        expect(move.to).toContain('src/view/');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. Error handling
  // ═══════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/mod.ts': 'export const x = 1;',
        'src/existing/mod.ts': 'export const y = 2;',
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('throws when source directory does not exist', async () => {
      await expect(
        directoryRename({
          repoPath: project.root,
          oldDir: 'src/nonexistent',
          newDir: 'src/view',
          dryRun: true,
        }),
      ).rejects.toThrow();
    });

    it('throws when target directory already exists', async () => {
      await expect(
        directoryRename({
          repoPath: project.root,
          oldDir: 'src/canvas',
          newDir: 'src/existing',
          dryRun: true,
        }),
      ).rejects.toThrow('already exists');
    });

    it('throws when source path is not a directory', async () => {
      await expect(
        directoryRename({
          repoPath: project.root,
          oldDir: 'src/canvas/mod.ts',
          newDir: 'src/view',
          dryRun: true,
        }),
      ).rejects.toThrow('not a directory');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. Directory with only non-TS files
  // ═══════════════════════════════════════════════════════════════════════

  describe('directory with only non-TS files', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'assets/images/logo.svg': '<svg></svg>',
        'assets/images/icon.png': 'fake-png-data',
        'assets/images/nested/badge.svg': '<svg>badge</svg>',
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('moves all files without errors and produces no edits', async () => {
      const result = await directoryRename({
        repoPath: project.root,
        oldDir: 'assets/images',
        newDir: 'assets/icons',
        dryRun: false,
      });

      // Files moved
      expect(result.files_moved.length).toBe(3);
      expect(await fileExists(project, 'assets/icons/logo.svg')).toBe(true);
      expect(await fileExists(project, 'assets/icons/icon.png')).toBe(true);
      expect(await fileExists(project, 'assets/icons/nested/badge.svg')).toBe(true);

      // No import edits (no TS files)
      expect(result.edits.length).toBe(0);

      // Old dir cleaned up
      expect(await dirExists(project, 'assets/images')).toBe(false);

      // Content preserved
      const svgContent = await readFile(project, 'assets/icons/logo.svg');
      expect(svgContent).toBe('<svg></svg>');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 13. Type-only imports and dynamic imports
  // ═══════════════════════════════════════════════════════════════════════

  describe('type-only imports', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/types.ts': [
          'export interface Point { x: number; y: number; }',
          'export type Color = "red" | "blue";',
        ].join('\n'),
        'src/consumer.ts': [
          'import type { Point } from "./canvas/types";',
          'import { type Color } from "./canvas/types";',
          '',
          'const p: Point = { x: 1, y: 2 };',
          'const c: Color = "red";',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates type-only import paths', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
      });

      const consumerContent = await readFile(project, 'src/consumer.ts');
      expect(consumerContent).toContain('./view/types');
      expect(consumerContent).not.toContain('./canvas/');
      // Type import syntax preserved
      expect(consumerContent).toContain('import type {');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14. Sibling directory rename (not changing depth)
  // ═══════════════════════════════════════════════════════════════════════

  describe('sibling directory rename (same depth)', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/old-name/service.ts': [
          'export class Service {',
          '  handle() { return "ok"; }',
          '}',
        ].join('\n'),
        'src/other/client.ts': [
          'import { Service } from "../old-name/service";',
          '',
          'export const svc = new Service();',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames to sibling path and updates relative imports', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/old-name',
        newDir: 'src/new-name',
      });

      expect(await fileExists(project, 'src/new-name/service.ts')).toBe(true);
      expect(await dirExists(project, 'src/old-name')).toBe(false);

      const clientContent = await readFile(project, 'src/other/client.ts');
      expect(clientContent).toContain('../new-name/service');
      expect(clientContent).not.toContain('../old-name/');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 15. Multiple consumers across different depths
  // ═══════════════════════════════════════════════════════════════════════

  describe('consumers at different directory depths', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/canvas/api.ts': [
          'export function apiCall() { return "data"; }',
        ].join('\n'),
        'src/root-consumer.ts': [
          'import { apiCall } from "./canvas/api";',
          'apiCall();',
        ].join('\n'),
        'src/a/consumer.ts': [
          'import { apiCall } from "../canvas/api";',
          'apiCall();',
        ].join('\n'),
        'src/a/b/deep-consumer.ts': [
          'import { apiCall } from "../../canvas/api";',
          'apiCall();',
        ].join('\n'),
        'src/a/b/c/deepest.ts': [
          'import { apiCall } from "../../../canvas/api";',
          'apiCall();',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates import paths at all depths correctly', async () => {
      const result = await renameAndAssert(project, {
        oldDir: 'src/canvas',
        newDir: 'src/view',
      });

      const rootContent = await readFile(project, 'src/root-consumer.ts');
      expect(rootContent).toContain('./view/api');

      const aContent = await readFile(project, 'src/a/consumer.ts');
      expect(aContent).toContain('../view/api');

      const bContent = await readFile(project, 'src/a/b/deep-consumer.ts');
      expect(bContent).toContain('../../view/api');

      const cContent = await readFile(project, 'src/a/b/c/deepest.ts');
      expect(cContent).toContain('../../../view/api');

      // None should reference old path
      for (const content of [rootContent, aContent, bContent, cContent]) {
        expect(content).not.toContain('/canvas/');
      }
    });
  });
});
