/**
 * Integration Tests: Semantic Diff, Breaking Changes, and Commit Planner
 *
 * Tests the three subsystems together:
 *   - semantic-differ: 3-pass AST diff algorithm
 *   - breaking-changes: export-aware breaking change classification
 *   - commit-planner: union-find grouping of changes into logical commits
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { classifyBreaking, annotateBreaking } from '../../src/core/diff/breaking-changes.js';
import {
  planCommits,
  isTestFile,
  correspondingSourceFile,
} from '../../src/core/diff/commit-planner.js';
import type { Definition, SymbolChange, FieldDelta, ChangeKind } from '../../src/core/diff/types.js';
import type { FileChangeSummary, CouplingEdge } from '../../src/core/diff/commit-planner.js';

// Lazy-import semantic-differ to avoid crashing when tree-sitter native bindings
// are unavailable (e.g. tree-sitter-kotlin on unsupported Node ABI).
let diff: typeof import('../../src/core/diff/semantic-differ.js').diff;
let extractDefinitionsFromSource: typeof import('../../src/core/diff/semantic-differ.js').extractDefinitionsFromSource;
let treeSitterAvailable = false;

beforeAll(async () => {
  try {
    const mod = await import('../../src/core/diff/semantic-differ.js');
    diff = mod.diff;
    extractDefinitionsFromSource = mod.extractDefinitionsFromSource;
    treeSitterAvailable = true;
  } catch {
    // tree-sitter native bindings not available — diff tests will be skipped
  }
});

// ============================================================================
// HELPER
// ============================================================================

function makeDef(overrides: Partial<Definition> & { qualifiedName: string }): Definition {
  return {
    name: overrides.qualifiedName.split(':').pop()!,
    label: 'Function',
    filePath: 'src/test.ts',
    startLine: 1,
    endLine: 10,
    signature: '()',
    paramTypes: [],
    returnType: 'void',
    isExported: true,
    decorators: [],
    baseClasses: [],
    lines: 10,
    ...overrides,
  };
}

// ============================================================================
// SEMANTIC DIFFER
// ============================================================================

describe('semantic-differ: diff()', () => {
  beforeAll(() => {
    if (!treeSitterAvailable) throw new Error('tree-sitter unavailable — skipping diff tests');
  });

  // ── Pass 1: exact QN match ──────────────────────────────────────────────

  it('pass 1 — SignatureChanged when return type differs', () => {
    const old = makeDef({ qualifiedName: 'qn:parseUser', returnType: 'void' });
    const neu = makeDef({ qualifiedName: 'qn:parseUser', returnType: 'User' });

    const changes = diff([old], [neu], 'src/test.ts', 'M');

    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('SignatureChanged');
    expect(changes[0].qualifiedName).toBe('qn:parseUser');
    const delta = changes[0].deltas.find(d => d.field === 'return_type');
    expect(delta).toBeDefined();
    expect(delta!.old).toBe('void');
    expect(delta!.new).toBe('User');
  });

  it('pass 1 — BodyChanged when only line count differs', () => {
    const old = makeDef({ qualifiedName: 'qn:buildQuery', lines: 10, endLine: 10 });
    const neu = makeDef({ qualifiedName: 'qn:buildQuery', lines: 20, endLine: 20 });

    const changes = diff([old], [neu], 'src/test.ts', 'M');

    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('BodyChanged');
    const delta = changes[0].deltas.find(d => d.field === 'lines');
    expect(delta).toBeDefined();
    expect(delta!.old).toBe('10');
    expect(delta!.new).toBe('20');
  });

  // ── Pass 2: fuzzy rename ────────────────────────────────────────────────

  it('pass 2 — Renamed detected for same label/params/return with different QN', () => {
    const old = makeDef({
      qualifiedName: 'qn:foo',
      name: 'foo',
      label: 'Function',
      paramTypes: ['string'],
      returnType: 'number',
      lines: 8,
    });
    const neu = makeDef({
      qualifiedName: 'qn:bar',
      name: 'bar',
      label: 'Function',
      paramTypes: ['string'],
      returnType: 'number',
      lines: 8,
    });

    const changes = diff([old], [neu], 'src/test.ts', 'M');

    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('Renamed');
    expect(changes[0].name).toBe('bar');
    expect(changes[0].oldQualifiedName).toBe('qn:foo');
  });

  // ── Pass 3: add / remove ────────────────────────────────────────────────

  it('pass 3 — Removed for old-only and Added for new-only', () => {
    const deleted = makeDef({ qualifiedName: 'qn:deleted_fn', name: 'deleted_fn' });
    const added = makeDef({ qualifiedName: 'qn:new_fn', name: 'new_fn' });

    const changes = diff([deleted], [added], 'src/test.ts', 'M');

    // The two have different names but also different param counts / return types so
    // the fuzzy heuristic may or may not match — but with a single candidate on each
    // side and matching defaults (same paramTypes [], returnType, lines) Pass 2 will
    // fire. We therefore use clearly mismatched definitions.
    const deletedDistinct = makeDef({
      qualifiedName: 'qn:deleted_fn',
      name: 'deleted_fn',
      paramTypes: ['string', 'number'],
      returnType: 'boolean',
    });
    const addedDistinct = makeDef({
      qualifiedName: 'qn:new_fn',
      name: 'new_fn',
      paramTypes: [],
      returnType: 'void',
      lines: 50,
    });

    const changes2 = diff([deletedDistinct], [addedDistinct], 'src/test.ts', 'M');
    const kinds = changes2.map(c => c.kind).sort();
    expect(kinds).toContain('Removed');
    expect(kinds).toContain('Added');
  });

  it('no changes when old and new definitions are identical', () => {
    const def = makeDef({ qualifiedName: 'qn:stable' });
    const changes = diff([def], [def], 'src/test.ts', 'M');
    expect(changes).toHaveLength(0);
  });

  // ── Fast paths ──────────────────────────────────────────────────────────

  it('fileStatus A — all defs are Added', () => {
    const d1 = makeDef({ qualifiedName: 'qn:alpha' });
    const d2 = makeDef({ qualifiedName: 'qn:beta' });
    const changes = diff([], [d1, d2], 'src/new.ts', 'A');
    expect(changes).toHaveLength(2);
    expect(changes.every(c => c.kind === 'Added')).toBe(true);
  });

  it('fileStatus D — all defs are Removed', () => {
    const d1 = makeDef({ qualifiedName: 'qn:alpha' });
    const changes = diff([d1], [], 'src/old.ts', 'D');
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('Removed');
  });
});

// ── Real source code round-trip (tree-sitter) ──────────────────────────────

describe('semantic-differ: extractDefinitionsFromSource + diff()', { timeout: 30000 }, () => {
  beforeAll(() => {
    if (!treeSitterAvailable) throw new Error('tree-sitter unavailable — skipping');
  });
  const filePath = 'src/auth.ts';

  const sourceV1 = `
export function validateToken(token: string): boolean {
  return token.length > 0;
}

export function parseUser(id: number): string {
  return String(id);
}
`.trim();

  const sourceV2 = `
export function validateToken(token: string, secret: string): boolean {
  return token.length > 0 && secret.length > 0;
}

export function fetchUser(id: number): string {
  return String(id);
}
`.trim();

  it('detects a signature change and a rename via real tree-sitter parsing', async () => {
    const oldDefs = await extractDefinitionsFromSource(filePath, sourceV1);
    const newDefs = await extractDefinitionsFromSource(filePath, sourceV2);

    expect(oldDefs.length).toBeGreaterThan(0);
    expect(newDefs.length).toBeGreaterThan(0);

    const changes = diff(oldDefs, newDefs, filePath, 'M');

    // validateToken changed its signature (extra `secret` param)
    const sigChange = changes.find(
      c => c.name === 'validateToken' && c.kind === 'SignatureChanged',
    );
    expect(sigChange).toBeDefined();

    // parseUser → fetchUser should be detected as a rename (same label, params, return)
    const rename = changes.find(c => c.kind === 'Renamed');
    expect(rename).toBeDefined();
    expect(rename!.name).toBe('fetchUser');
  });
});

// ============================================================================
// BREAKING CHANGES
// ============================================================================

describe('breaking-changes: classifyBreaking / annotateBreaking', () => {
  // Helper to build a minimal SymbolChange
  function makeChange(
    kind: ChangeKind,
    qn: string,
    opts: Partial<SymbolChange> = {},
  ): SymbolChange {
    return {
      kind,
      label: 'Function',
      name: qn.split(':').pop()!,
      qualifiedName: qn,
      filePath: 'src/test.ts',
      deltas: opts.deltas ?? [],
      isBreaking: false,
      ...opts,
    };
  }

  it('Removed exported function → breaking', () => {
    const oldDef = makeDef({ qualifiedName: 'qn:doWork', isExported: true });
    const change = makeChange('Removed', 'qn:doWork');

    const breaking = annotateBreaking([change], [oldDef], []);

    expect(breaking[0].isBreaking).toBe(true);
  });

  it('Removed non-exported function → NOT breaking', () => {
    const oldDef = makeDef({ qualifiedName: 'qn:internalHelper', isExported: false });
    const change = makeChange('Removed', 'qn:internalHelper');

    const breaking = annotateBreaking([change], [oldDef], []);

    expect(breaking[0].isBreaking).toBe(false);
  });

  it('SignatureChanged on exported function → breaking', () => {
    const oldDef = makeDef({ qualifiedName: 'qn:compute', isExported: true });
    const newDef = makeDef({ qualifiedName: 'qn:compute', isExported: true, returnType: 'number' });
    const delta: FieldDelta = { field: 'return_type', old: 'void', new: 'number' };
    const change = makeChange('SignatureChanged', 'qn:compute', { deltas: [delta] });

    const breaking = annotateBreaking([change], [oldDef], [newDef]);

    expect(breaking[0].isBreaking).toBe(true);
  });

  it('BodyChanged → never breaking', () => {
    const oldDef = makeDef({ qualifiedName: 'qn:render', isExported: true });
    const newDef = makeDef({ qualifiedName: 'qn:render', isExported: true, lines: 50 });
    const delta: FieldDelta = { field: 'lines', old: '10', new: '50' };
    const change = makeChange('BodyChanged', 'qn:render', { deltas: [delta] });

    const breaking = annotateBreaking([change], [oldDef], [newDef]);

    expect(breaking[0].isBreaking).toBe(false);
  });

  it('Added → never breaking', () => {
    const newDef = makeDef({ qualifiedName: 'qn:newFeature', isExported: true });
    const change = makeChange('Added', 'qn:newFeature');

    const breaking = annotateBreaking([change], [], [newDef]);

    expect(breaking[0].isBreaking).toBe(false);
  });

  it('VisibilityChanged exported → unexported = breaking', () => {
    const oldDef = makeDef({ qualifiedName: 'qn:formatDate', isExported: true });
    const newDef = makeDef({ qualifiedName: 'qn:formatDate', isExported: false });
    const delta: FieldDelta = { field: 'is_exported', old: 'true', new: 'false' };
    const change = makeChange('VisibilityChanged', 'qn:formatDate', { deltas: [delta] });

    const breaking = annotateBreaking([change], [oldDef], [newDef]);

    expect(breaking[0].isBreaking).toBe(true);
  });

  it('VisibilityChanged unexported → exported = NOT breaking (additive)', () => {
    const oldDef = makeDef({ qualifiedName: 'qn:helper', isExported: false });
    const newDef = makeDef({ qualifiedName: 'qn:helper', isExported: true });
    const delta: FieldDelta = { field: 'is_exported', old: 'false', new: 'true' };
    const change = makeChange('VisibilityChanged', 'qn:helper', { deltas: [delta] });

    const breaking = annotateBreaking([change], [oldDef], [newDef]);

    expect(breaking[0].isBreaking).toBe(false);
  });

  it('classifyBreaking mutates isBreaking in-place and returns breaking subset', () => {
    const oldDef = makeDef({ qualifiedName: 'qn:gone', isExported: true });
    const removed = makeChange('Removed', 'qn:gone');
    const added = makeChange('Added', 'qn:newThing');

    const oldMap = new Map([['qn:gone', oldDef]]);
    const newMap = new Map<string, Definition>();

    const breakingSubset = classifyBreaking([removed, added], oldMap, newMap);

    expect(removed.isBreaking).toBe(true);
    expect(added.isBreaking).toBe(false);
    expect(breakingSubset).toHaveLength(1);
    expect(breakingSubset[0].qualifiedName).toBe('qn:gone');
  });
});

// ============================================================================
// COMMIT PLANNER
// ============================================================================

describe('commit-planner: isTestFile()', () => {
  it.each([
    ['foo.test.ts', true],
    ['foo.test.js', true],
    ['foo.spec.ts', true],
    ['foo.spec.js', true],
    ['foo_test.go', true],
    ['test_foo.py', true],
    ['foo_test.py', true],
    ['foo_spec.rb', true],
    ['foo.ts', false],
    ['foo.go', false],
    ['foo.py', false],
    ['foo.rb', false],
    ['testing.ts', false],
  ])('%s → %s', (file, expected) => {
    expect(isTestFile(file)).toBe(expected);
  });
});

describe('commit-planner: correspondingSourceFile()', () => {
  it('foo.test.ts → foo.ts', () => {
    expect(correspondingSourceFile('foo.test.ts')).toBe('foo.ts');
  });

  it('foo_test.go → foo.go', () => {
    expect(correspondingSourceFile('foo_test.go')).toBe('foo.go');
  });

  it('test_foo.py → foo.py', () => {
    expect(correspondingSourceFile('test_foo.py')).toBe('foo.py');
  });

  it('foo_test.py → foo.py', () => {
    expect(correspondingSourceFile('foo_test.py')).toBe('foo.py');
  });

  it('foo_spec.rb → foo.rb', () => {
    expect(correspondingSourceFile('foo_spec.rb')).toBe('foo.rb');
  });

  it('preserves directory prefix', () => {
    expect(correspondingSourceFile('src/auth/auth.test.ts')).toBe('src/auth/auth.ts');
  });

  it('returns empty string for non-test file', () => {
    expect(correspondingSourceFile('foo.ts')).toBe('');
  });
});

describe('commit-planner: planCommits()', () => {
  function makeSymbolChange(qn: string, kind: ChangeKind = 'BodyChanged'): SymbolChange {
    return {
      kind,
      label: 'Function',
      name: qn.split(':').pop()!,
      qualifiedName: qn,
      filePath: 'src/test.ts',
      deltas: [],
      isBreaking: false,
    };
  }

  it('two coupled files are grouped into one commit', () => {
    const changeA = makeSymbolChange('src/a.ts:funcA');
    const changeB = makeSymbolChange('src/b.ts:funcB');

    const summaries: FileChangeSummary[] = [
      { path: 'src/a.ts', changes: [changeA] },
      { path: 'src/b.ts', changes: [changeB] },
    ];
    const couplings: CouplingEdge[] = [
      { fromQN: 'src/a.ts:funcA', toQN: 'src/b.ts:funcB', type: 'CALLS' },
    ];

    const plan = planCommits(summaries, couplings);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].files).toContain('src/a.ts');
    expect(plan.groups[0].files).toContain('src/b.ts');
    expect(plan.groups[0].reason).toMatch(/coupled/);
  });

  it('unrelated files are placed in separate groups', () => {
    const changeX = makeSymbolChange('pkg/x.ts:funcX');
    const changeY = makeSymbolChange('pkg/y.ts:funcY', 'Added');

    // Make sure they do NOT fuzzy-match by using distinct param counts
    const summaries: FileChangeSummary[] = [
      { path: 'pkg/x.ts', changes: [changeX] },
      { path: 'pkg/y.ts', changes: [changeY] },
    ];

    const plan = planCommits(summaries, []);

    expect(plan.groups).toHaveLength(2);
    const files = plan.groups.flatMap(g => g.files);
    expect(files).toContain('pkg/x.ts');
    expect(files).toContain('pkg/y.ts');
  });

  it('test file and its source file are grouped together', () => {
    const srcChange = makeSymbolChange('src/parser.ts:parse');
    const testChange = makeSymbolChange('src/parser.test.ts:testParse');

    const summaries: FileChangeSummary[] = [
      { path: 'src/parser.ts', changes: [srcChange] },
      { path: 'src/parser.test.ts', changes: [testChange] },
    ];

    const plan = planCommits(summaries, []);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].files).toContain('src/parser.ts');
    expect(plan.groups[0].files).toContain('src/parser.test.ts');
    expect(plan.groups[0].reason).toBe('test + source');
  });

  it('draft message is truncated to 80 characters', () => {
    // Generate many Added changes with long names so the message overflows 80 chars.
    const longNames = [
      'reallyLongFunctionNameAlpha',
      'reallyLongFunctionNameBeta',
      'reallyLongFunctionNameGamma',
      'reallyLongFunctionNameDelta',
    ];
    const changes = longNames.map(n =>
      makeSymbolChange(`src/long-module.ts:${n}`, 'Added'),
    );
    const summaries: FileChangeSummary[] = [
      { path: 'src/long-module.ts', changes },
    ];

    const plan = planCommits(summaries, []);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].draftMessage.length).toBeLessThanOrEqual(80);
  });

  it('returns empty plan for empty input', () => {
    const plan = planCommits([], []);
    expect(plan.groups).toHaveLength(0);
    expect(plan.ungrouped).toHaveLength(0);
  });
});
