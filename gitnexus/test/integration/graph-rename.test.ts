/**
 * Integration Tests: graph + text search fallback rename
 *
 * Tests the fallback rename engine used when ts-morph (TS/JS) and rope (Python)
 * cannot resolve the symbol. Each test creates a temp directory with source files,
 * then verifies that graphTextSearchRename produces correct edits.
 *
 * Categories:
 * 1. Basic rename (definition + usages, dry run vs apply)
 * 2. Stale index scenarios (startLine wrong — the original bug)
 * 3. Re-exports and self-references in the definition file
 * 4. Text search fallback for graph misses
 * 5. Edge cases (no definition file, missing files, special characters)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { graphTextSearchRename, type GraphRenameEdit } from '../../src/core/rename/graph-rename.js';

// ─── Helpers ────────────────────────────────────────────────────────────

interface TempProject {
  root: string;
  cleanup: () => Promise<void>;
}

async function createTempProject(files: Record<string, string>): Promise<TempProject> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-rename-'));
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

async function readFile(project: TempProject, filePath: string): Promise<string> {
  return fs.readFile(path.join(project.root, filePath), 'utf-8');
}

function editsByFile(edits: GraphRenameEdit[]): Map<string, GraphRenameEdit[]> {
  const map = new Map<string, GraphRenameEdit[]>();
  for (const edit of edits) {
    if (!map.has(edit.filePath)) map.set(edit.filePath, []);
    map.get(edit.filePath)!.push(edit);
  }
  return map;
}

// ─── 1. Basic rename ────────────────────────────────────────────────────

describe('graph-rename: basic', () => {
  let project: TempProject;

  beforeAll(async () => {
    project = await createTempProject({
      'src/utils.ts': [
        'export function getData() {',
        '  return fetch("/api/data");',
        '}',
      ].join('\n'),
      'src/app.ts': [
        'import { getData } from "./utils";',
        '',
        'async function main() {',
        '  const result = await getData();',
        '  console.log(result);',
        '}',
      ].join('\n'),
    });
  });
  afterAll(async () => { await project.cleanup(); });

  it('renames definition and usages in dry run', async () => {
    const result = await graphTextSearchRename({
      repoPath: project.root,
      defFile: 'src/utils.ts',
      incomingRefs: [{ filePath: 'src/app.ts' }],
      oldName: 'getData',
      newName: 'fetchData',
      dryRun: true,
    });

    expect(result.edits.length).toBeGreaterThanOrEqual(3);
    const byFile = editsByFile(result.edits);

    // Definition file: function declaration line
    const defEdits = byFile.get('src/utils.ts')!;
    expect(defEdits).toBeDefined();
    expect(defEdits.some(e => e.new_text.includes('fetchData'))).toBe(true);

    // Usage file: import + call
    const appEdits = byFile.get('src/app.ts')!;
    expect(appEdits).toBeDefined();
    expect(appEdits.length).toBe(2); // import line + call line

    // Files should not be modified in dry run
    const utilsContent = await readFile(project, 'src/utils.ts');
    expect(utilsContent).toContain('getData');
    expect(utilsContent).not.toContain('fetchData');
  });

  it('applies edits when dryRun=false', async () => {
    const result = await graphTextSearchRename({
      repoPath: project.root,
      defFile: 'src/utils.ts',
      incomingRefs: [{ filePath: 'src/app.ts' }],
      oldName: 'getData',
      newName: 'fetchData',
      dryRun: false,
    });

    expect(result.edits.length).toBeGreaterThanOrEqual(3);
    expect(result.warnings).toHaveLength(0);

    // Definition file: updated
    const utilsContent = await readFile(project, 'src/utils.ts');
    expect(utilsContent).toContain('fetchData');
    expect(utilsContent).not.toContain('getData');

    // Usage file: updated
    const appContent = await readFile(project, 'src/app.ts');
    expect(appContent).toContain('fetchData');
    expect(appContent).not.toContain('getData');
  });
});

// ─── 2. Stale index — the original bug ─────────────────────────────────

describe('graph-rename: stale index', () => {
  it('renames definition even when startLine would be wrong (full-file scan)', async () => {
    // Simulate: the graph says the definition is in utils.ts,
    // but the actual function moved to a different line since indexing.
    // The old code only checked startLine — this test proves the fix works.
    const project = await createTempProject({
      'src/utils.ts': [
        '// some new comment that shifted lines',
        '// another comment',
        '// yet another',
        'export function getData() {',
        '  return fetch("/api/data");',
        '}',
      ].join('\n'),
      'src/app.ts': [
        'import { getData } from "./utils";',
        'getData();',
      ].join('\n'),
    });

    try {
      const result = await graphTextSearchRename({
        repoPath: project.root,
        defFile: 'src/utils.ts',
        incomingRefs: [{ filePath: 'src/app.ts' }],
        oldName: 'getData',
        newName: 'fetchData',
        dryRun: true,
      });

      const byFile = editsByFile(result.edits);

      // The definition MUST be found even though it's not on the old startLine
      const defEdits = byFile.get('src/utils.ts')!;
      expect(defEdits).toBeDefined();
      expect(defEdits.some(e => e.line === 4 && e.new_text.includes('fetchData'))).toBe(true);

      // Usages must also be found
      const appEdits = byFile.get('src/app.ts')!;
      expect(appEdits).toBeDefined();
      expect(appEdits.length).toBe(2);
    } finally {
      await project.cleanup();
    }
  });

  it('finds definition when defFile has no graph refs (text search catches it)', async () => {
    // Even with zero incoming refs, the definition file is fully scanned
    const project = await createTempProject({
      'src/utils.ts': [
        'export function getData() {',
        '  return 42;',
        '}',
      ].join('\n'),
    });

    try {
      const result = await graphTextSearchRename({
        repoPath: project.root,
        defFile: 'src/utils.ts',
        incomingRefs: [],
        oldName: 'getData',
        newName: 'fetchData',
        dryRun: true,
      });

      expect(result.edits.length).toBe(1);
      expect(result.edits[0].new_text).toContain('fetchData');
      expect(result.edits[0].confidence).toBe('graph');
    } finally {
      await project.cleanup();
    }
  });
});

// ─── 3. Re-exports and self-references ──────────────────────────────────

describe('graph-rename: re-exports and self-references', () => {
  it('renames re-exports in the definition file', async () => {
    const project = await createTempProject({
      'src/utils.ts': [
        'function getData() {',
        '  return fetch("/api");',
        '}',
        '',
        'export { getData };',
      ].join('\n'),
    });

    try {
      const result = await graphTextSearchRename({
        repoPath: project.root,
        defFile: 'src/utils.ts',
        incomingRefs: [],
        oldName: 'getData',
        newName: 'fetchData',
        dryRun: true,
      });

      // Both the declaration (line 1) and the export (line 5) should be found
      expect(result.edits.length).toBe(2);
      expect(result.edits.some(e => e.line === 1)).toBe(true);
      expect(result.edits.some(e => e.line === 5)).toBe(true);
    } finally {
      await project.cleanup();
    }
  });

  it('renames recursive self-calls in the definition file', async () => {
    const project = await createTempProject({
      'src/tree.ts': [
        'export function traverse(node: any) {',
        '  if (!node) return;',
        '  process(node);',
        '  traverse(node.left);',
        '  traverse(node.right);',
        '}',
      ].join('\n'),
    });

    try {
      const result = await graphTextSearchRename({
        repoPath: project.root,
        defFile: 'src/tree.ts',
        incomingRefs: [],
        oldName: 'traverse',
        newName: 'walkTree',
        dryRun: true,
      });

      // Line 1 (declaration), line 4 (recursive call), line 5 (recursive call)
      expect(result.edits.length).toBe(3);
    } finally {
      await project.cleanup();
    }
  });
});

// ─── 4. Text search fallback ────────────────────────────────────────────

describe('graph-rename: text search fallback', () => {
  it('finds usages in files not covered by graph refs', async () => {
    const project = await createTempProject({
      'src/utils.ts': [
        'export function getData() { return 42; }',
      ].join('\n'),
      'src/known-caller.ts': [
        'import { getData } from "./utils";',
        'getData();',
      ].join('\n'),
      // This file is NOT in incomingRefs — text search should find it
      'src/unknown-caller.ts': [
        'import { getData } from "./utils";',
        'const x = getData();',
      ].join('\n'),
    });

    try {
      const result = await graphTextSearchRename({
        repoPath: project.root,
        defFile: 'src/utils.ts',
        incomingRefs: [{ filePath: 'src/known-caller.ts' }],
        oldName: 'getData',
        newName: 'fetchData',
        dryRun: true,
      });

      const byFile = editsByFile(result.edits);

      // Graph should cover definition + known caller
      expect(byFile.has('src/utils.ts')).toBe(true);
      expect(byFile.has('src/known-caller.ts')).toBe(true);

      // Text search should catch the unknown caller
      expect(byFile.has('src/unknown-caller.ts')).toBe(true);
      const unknownEdits = byFile.get('src/unknown-caller.ts')!;
      expect(unknownEdits.every(e => e.confidence === 'text_search')).toBe(true);

      expect(result.textSearchEdits).toBeGreaterThan(0);
    } finally {
      await project.cleanup();
    }
  });
});

// ─── 5. Edge cases ──────────────────────────────────────────────────────

describe('graph-rename: edge cases', () => {
  it('handles undefined defFile gracefully', async () => {
    const project = await createTempProject({
      'src/app.ts': 'const x = getData();',
    });

    try {
      const result = await graphTextSearchRename({
        repoPath: project.root,
        defFile: undefined,
        incomingRefs: [{ filePath: 'src/app.ts' }],
        oldName: 'getData',
        newName: 'fetchData',
        dryRun: true,
      });

      // Should still find the usage via incoming refs
      expect(result.edits.length).toBe(1);
      expect(result.warnings).toHaveLength(0);
    } finally {
      await project.cleanup();
    }
  });

  it('handles missing files with warnings instead of throwing', async () => {
    const project = await createTempProject({
      'src/app.ts': 'getData();',
    });

    try {
      const result = await graphTextSearchRename({
        repoPath: project.root,
        defFile: 'src/nonexistent.ts',
        incomingRefs: [{ filePath: 'src/also-missing.ts' }],
        oldName: 'getData',
        newName: 'fetchData',
        dryRun: true,
      });

      expect(result.warnings.length).toBe(2);
    } finally {
      await project.cleanup();
    }
  });

  it('does not rename partial word matches', async () => {
    const project = await createTempProject({
      'src/utils.ts': [
        'export function get() { return 1; }',
        'export function getAll() { return 2; }',
        'export function getById() { return 3; }',
      ].join('\n'),
    });

    try {
      const result = await graphTextSearchRename({
        repoPath: project.root,
        defFile: 'src/utils.ts',
        incomingRefs: [],
        oldName: 'get',
        newName: 'fetch',
        dryRun: true,
      });

      // Only the standalone "get" on line 1, not getAll or getById
      expect(result.edits.length).toBe(1);
      expect(result.edits[0].line).toBe(1);
    } finally {
      await project.cleanup();
    }
  });

  it('deduplicates edits for the same line', async () => {
    // defFile and incomingRefs both point to the same file
    const project = await createTempProject({
      'src/utils.ts': [
        'export function getData() { return getData(); }',
      ].join('\n'),
    });

    try {
      const result = await graphTextSearchRename({
        repoPath: project.root,
        defFile: 'src/utils.ts',
        incomingRefs: [{ filePath: 'src/utils.ts' }], // same file as def
        oldName: 'getData',
        newName: 'fetchData',
        dryRun: true,
      });

      // Only 1 edit for line 1, not duplicated
      expect(result.edits.length).toBe(1);
    } finally {
      await project.cleanup();
    }
  });

  it('handles symbol names that are regex-sensitive substrings', async () => {
    // "get" could match "getAll", "getById" etc. — word boundary must prevent this
    const project = await createTempProject({
      'src/utils.ts': [
        'export function get_item() { return 1; }',
        'export function get_item_by_id() { return 2; }',
      ].join('\n'),
      'src/app.ts': [
        'import { get_item } from "./utils";',
        'get_item();',
      ].join('\n'),
    });

    try {
      const result = await graphTextSearchRename({
        repoPath: project.root,
        defFile: 'src/utils.ts',
        incomingRefs: [{ filePath: 'src/app.ts' }],
        oldName: 'get_item',
        newName: 'fetch_item',
        dryRun: true,
      });

      // Should rename get_item (3 occurrences) but NOT get_item_by_id
      expect(result.edits.length).toBe(3);
      expect(result.edits.every(e => !e.new_text.includes('get_item'))).toBe(true);
      expect(result.warnings).toHaveLength(0);
    } finally {
      await project.cleanup();
    }
  });
});
