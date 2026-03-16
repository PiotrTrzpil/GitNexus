/**
 * Commit Planner
 *
 * Groups symbol changes into logical commit boundaries using union-find.
 * Three coupling signals: graph edges, file co-location, test-source pairing.
 *
 * Ported from codebase-memory-mcp/internal/semdiff/commitplan.go
 */

import * as nodePath from 'node:path';
import { SymbolChange, CommitGroup, CommitPlan, ChangeKind } from './types.js';

// ============================================================================
// PUBLIC INPUT TYPES
// ============================================================================

/** A directed coupling edge between two qualified names (e.g. from the call graph). */
export interface CouplingEdge {
  fromQN: string;
  toQN: string;
  /** Edge type label, e.g. 'CALLS', 'IMPORTS', 'IMPLEMENTS' */
  type: string;
}

/** All symbol changes that occurred in a single file. */
export interface FileChangeSummary {
  path: string;
  changes: SymbolChange[];
}

// ============================================================================
// PUBLIC ENTRY POINT
// ============================================================================

/**
 * PlanCommits groups symbol changes into logical commit boundaries using
 * coupling edges (graph relationships between changed symbols) and file
 * co-location. Returns a CommitPlan with suggested commits.
 */
export function planCommits(
  fileSummaries: FileChangeSummary[],
  couplings: CouplingEdge[],
): CommitPlan {
  if (fileSummaries.length === 0) {
    return { groups: [], ungrouped: [] };
  }

  // Build a flat list of all changes with their file path, and an index
  // from qualifiedName to position in allChanges for quick lookup.
  const allChanges: IndexedChange[] = [];
  const qnIndex = new Map<string, number>(); // QN → index in allChanges

  for (const fs of fileSummaries) {
    for (const sc of fs.changes) {
      const idx = allChanges.length;
      qnIndex.set(sc.qualifiedName, idx);
      allChanges.push({ change: sc, filePath: fs.path });
    }
  }

  if (allChanges.length === 0) {
    return { groups: [], ungrouped: [] };
  }

  // -------------------------------------------------------------------------
  // Step 1: Union-Find grouping
  // -------------------------------------------------------------------------
  const uf = new UnionFind();
  for (const ic of allChanges) {
    uf.add(ic.change.qualifiedName);
  }

  // 1a. Coupling edges: union symbols that are explicitly coupled.
  for (const edge of couplings) {
    const fromOK = qnIndex.has(edge.fromQN);
    const toOK = qnIndex.has(edge.toQN);
    if (fromOK && toOK) {
      uf.union(edge.fromQN, edge.toQN);
    }
  }

  // 1b. File co-location: all changes in the same file belong together.
  for (const fs of fileSummaries) {
    if (fs.changes.length < 2) continue;
    const first = fs.changes[0].qualifiedName;
    for (let i = 1; i < fs.changes.length; i++) {
      uf.union(first, fs.changes[i].qualifiedName);
    }
  }

  // 1c. Test-source coupling: union test file changes with their source file.
  // Build a map from file path → QNs in that file.
  const fileToQNs = new Map<string, string[]>();
  for (const fs of fileSummaries) {
    for (const sc of fs.changes) {
      const existing = fileToQNs.get(fs.path) ?? [];
      existing.push(sc.qualifiedName);
      fileToQNs.set(fs.path, existing);
    }
  }

  for (const fs of fileSummaries) {
    if (!isTestFile(fs.path)) continue;
    const srcPath = correspondingSourceFile(fs.path);
    if (!srcPath) continue;
    const srcQNs = fileToQNs.get(srcPath);
    if (!srcQNs || srcQNs.length === 0) continue;
    // Union all test QNs with the first source QN (they'll all get connected
    // transitively via the file co-location union from step 1b).
    const testQNs = fileToQNs.get(fs.path);
    if (!testQNs || testQNs.length === 0) continue;
    uf.union(testQNs[0], srcQNs[0]);
  }

  // -------------------------------------------------------------------------
  // Step 2: Extract connected components.
  // -------------------------------------------------------------------------
  const components = new Map<string, IndexedChange[]>(); // root → changes
  for (const ic of allChanges) {
    const root = uf.find(ic.change.qualifiedName);
    const existing = components.get(root) ?? [];
    existing.push(ic);
    components.set(root, existing);
  }

  // -------------------------------------------------------------------------
  // Step 3: Build CommitGroup for each component.
  // -------------------------------------------------------------------------
  const groups: CommitGroup[] = [];
  for (const [root, ics] of components) {
    groups.push(buildCommitGroup(root, ics, couplings, qnIndex));
  }

  // -------------------------------------------------------------------------
  // Step 4: Sort groups (shorter/core paths first, then alphabetically).
  // -------------------------------------------------------------------------
  groups.sort((a, b) => {
    const aDepth = (a.files[0] ?? '').split('/').length - 1;
    const bDepth = (b.files[0] ?? '').split('/').length - 1;
    if (aDepth !== bDepth) return aDepth - bDepth;
    return (a.files[0] ?? '').localeCompare(b.files[0] ?? '');
  });

  return { groups, ungrouped: [] };
}

// ============================================================================
// COMMIT GROUP CONSTRUCTION
// ============================================================================

function buildCommitGroup(
  _root: string,
  ics: IndexedChange[],
  couplings: CouplingEdge[],
  qnIndex: Map<string, number>,
): CommitGroup {
  // Collect unique files and separate test vs. non-test changes.
  const fileSet = new Set<string>();
  const nonTestChanges: SymbolChange[] = [];
  let testCount = 0;

  for (const ic of ics) {
    fileSet.add(ic.filePath);
    if (isTestFile(ic.filePath)) {
      testCount++;
    } else {
      nonTestChanges.push(ic.change);
    }
  }

  const files = Array.from(fileSet).sort();

  // Derive scope from the common path prefix.
  const scope = deriveScope(files);

  // Generate draft message.
  const draftMessage = buildDraftMsg(scope, nonTestChanges, testCount);

  // Determine reason for grouping.
  const reason = deriveReason(ics, couplings, qnIndex);

  // All changes (test + non-test) go into the changes array.
  const changes = ics.map(ic => ic.change);

  return { scope, draftMessage, reason, files, changes };
}

// ============================================================================
// SCOPE DERIVATION
// ============================================================================

/** Returns a short scope string from the common file path prefix. */
function deriveScope(files: string[]): string {
  if (files.length === 0) return 'root';

  // Find the common directory prefix of all files.
  let commonDir = nodePath.dirname(files[0]);
  for (let i = 1; i < files.length; i++) {
    const d = nodePath.dirname(files[i]);
    commonDir = commonPathPrefix(commonDir, d);
  }

  // Use the last meaningful directory component.
  if (commonDir !== '' && commonDir !== '.') {
    return nodePath.basename(commonDir);
  }

  // Single file or root-level files: use the filename without extension.
  if (files.length === 1) {
    const base = nodePath.basename(files[0]);
    const ext = nodePath.extname(base);
    if (ext !== '') {
      return base.slice(0, base.length - ext.length);
    }
    return base;
  }

  return 'root';
}

/** Returns the longest common path prefix of two slash-separated paths. */
function commonPathPrefix(a: string, b: string): string {
  const aParts = a.split('/');
  const bParts = b.split('/');
  const common: string[] = [];
  for (let i = 0; i < aParts.length && i < bParts.length; i++) {
    if (aParts[i] !== bParts[i]) break;
    common.push(aParts[i]);
  }
  return common.join('/');
}

// ============================================================================
// REASON DERIVATION
// ============================================================================

/** Produces a human-readable explanation for why this group is together. */
function deriveReason(
  ics: IndexedChange[],
  couplings: CouplingEdge[],
  _qnIndex: Map<string, number>,
): string {
  // Build the set of QNs in this component.
  const qns = new Set<string>();
  for (const ic of ics) {
    qns.add(ic.change.qualifiedName);
  }

  // Check for coupling edges within this group.
  for (const edge of couplings) {
    if (qns.has(edge.fromQN) && qns.has(edge.toQN)) {
      const fromName = lastName(edge.fromQN);
      const toName = lastName(edge.toQN);
      const rel = edge.type.toLowerCase();
      return `coupled: ${fromName} ${rel} ${toName}`;
    }
  }

  // Check for test-source coupling.
  const files = new Set<string>();
  for (const ic of ics) {
    files.add(ic.filePath);
  }
  let hasTest = false;
  let hasSource = false;
  for (const f of files) {
    if (isTestFile(f)) {
      hasTest = true;
    } else {
      hasSource = true;
    }
  }
  if (hasTest && hasSource) {
    return 'test + source';
  }

  return 'same file';
}

/** Returns the last segment of a dot- or slash-separated qualified name. */
function lastName(qn: string): string {
  const i = Math.max(qn.lastIndexOf('.'), qn.lastIndexOf('/'));
  if (i >= 0) return qn.slice(i + 1);
  return qn;
}

// ============================================================================
// DRAFT MESSAGE GENERATION
// ============================================================================

/** Generates a neutral commit message from the non-test changes. */
function buildDraftMsg(scope: string, changes: SymbolChange[], testCount: number): string {
  if (changes.length === 0 && testCount > 0) {
    return `${scope}: add ${testCount} test functions`;
  }
  if (changes.length === 0) {
    return `${scope}: update`;
  }

  // Count dominant change kinds.
  const kindCounts = new Map<ChangeKind, number>();
  for (const sc of changes) {
    kindCounts.set(sc.kind, (kindCounts.get(sc.kind) ?? 0) + 1);
  }

  // Collect names per kind for short messages.
  const namesByKind = new Map<ChangeKind, string[]>();
  for (const sc of changes) {
    const existing = namesByKind.get(sc.kind) ?? [];
    existing.push(sc.name);
    namesByKind.set(sc.kind, existing);
  }

  type Fragment = { verb: string; desc: string };
  const frags: Fragment[] = [];

  const maxNames = 3; // show at most this many names before summarising

  const addFrag = (kind: ChangeKind, verb: string): void => {
    if ((kindCounts.get(kind) ?? 0) > 0) {
      const names = namesByKind.get(kind) ?? [];
      frags.push({ verb, desc: compactNames(names, maxNames, scope) });
    }
  };

  // Priority: Renamed > SignatureChanged > VisibilityChanged > Added > Removed > BodyChanged
  if ((kindCounts.get('Renamed') ?? 0) > 0) {
    const renames = changes.filter(sc => sc.kind === 'Renamed');
    if (renames.length <= maxNames) {
      for (const sc of renames) {
        const oldName = sc.oldQualifiedName ? lastName(sc.oldQualifiedName) : sc.name;
        frags.push({ verb: 'rename', desc: `${oldName} to ${sc.name}` });
      }
    } else {
      frags.push({ verb: 'rename', desc: `${renames.length} symbols in ${scope}` });
    }
  }
  addFrag('SignatureChanged', 'update');
  addFrag('VisibilityChanged', 'update');
  addFrag('Added', 'add');
  addFrag('Removed', 'remove');
  addFrag('BodyChanged', 'refactor');

  if (frags.length === 0) {
    return `${scope}: update`;
  }

  // Collapse if there's only one fragment type.
  if (frags.length === 1) {
    const msg = `${scope}: ${frags[0].verb} ${frags[0].desc}`;
    return truncate(msg, 80);
  }

  // Multiple fragment types: combine, then truncate.
  const parts = frags.map(f => `${f.verb} ${f.desc}`);
  const combined = `${scope}: ${parts.join(', ')}`;
  return truncate(combined, 80);
}

/** Formats a list of symbol names for use in a commit message. */
function compactNames(names: string[], max: number, scope: string): string {
  if (names.length === 0) return '';
  if (names.length <= max) return names.join(', ');
  return `${names.length} functions in ${scope}`;
}

/** Produces a short one-liner for a commit plan summary. */
export function compactSummary(sc: SymbolChange): string {
  const marker = changeKindMarker(sc.kind);
  const prefix = `${marker} ${sc.label} ${sc.name}`;

  switch (sc.kind) {
    case 'Added':
    case 'Removed':
      return prefix;
    case 'Renamed': {
      const oldName = sc.oldQualifiedName ? lastName(sc.oldQualifiedName) : sc.name;
      return `${prefix} — from ${oldName}`;
    }
    default: {
      // For modified symbols, append a brief description of what changed.
      const parts: string[] = [];
      for (const d of sc.deltas) {
        switch (d.field) {
          case 'signature':
            parts.push(`sig (${d.old} → ${d.new})`);
            break;
          case 'param_types':
            parts.push(`params (${d.old} → ${d.new})`);
            break;
          case 'return_type':
            parts.push(`returns (${d.old} → ${d.new})`);
            break;
          case 'is_exported':
            parts.push(d.new === 'true' ? 'exported' : 'unexported');
            break;
          case 'decorators':
          case 'base_classes':
            parts.push(`${d.field} changed`);
            break;
          case 'docstring':
            parts.push('docs');
            break;
          case 'complexity':
            parts.push(`complexity ${d.old}→${d.new}`);
            break;
          case 'lines':
            parts.push(`lines ${d.old}→${d.new}`);
            break;
        }
      }
      if (parts.length === 0) return prefix;
      return `${prefix} — ${parts.join(', ')}`;
    }
  }
}

/** Returns a short git-style marker for a ChangeKind. */
function changeKindMarker(kind: ChangeKind): string {
  switch (kind) {
    case 'Added': return 'A';
    case 'Removed': return 'D';
    case 'Renamed': return 'R';
    case 'VisibilityChanged': return 'V';
    default: return 'M'; // SignatureChanged, BodyChanged
  }
}

/** Trims a string to at most maxLen characters, appending '...' if truncated. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

// ============================================================================
// TEST FILE DETECTION AND SOURCE MAPPING
// ============================================================================

/** Returns true if the file path matches known test file patterns. */
export function isTestFile(filePath: string): boolean {
  const base = nodePath.basename(filePath);
  return (
    base.endsWith('_test.go') ||
    base.endsWith('_test.py') ||
    (base.startsWith('test_') && base.endsWith('.py')) ||
    base.endsWith('.test.ts') ||
    base.endsWith('.test.js') ||
    base.endsWith('.test.tsx') ||
    base.endsWith('.test.jsx') ||
    base.endsWith('.spec.ts') ||
    base.endsWith('.spec.js') ||
    base.endsWith('_spec.rb')
  );
}

/**
 * Returns the expected source file path for a test file,
 * or an empty string if the pattern is not recognised.
 */
export function correspondingSourceFile(testPath: string): string {
  const dir = nodePath.dirname(testPath);
  const base = nodePath.basename(testPath);

  // Go: foo_test.go → foo.go
  if (base.endsWith('_test.go')) {
    const src = base.slice(0, base.length - '_test.go'.length) + '.go';
    return nodePath.join(dir, src);
  }

  // Python: foo_test.py → foo.py
  if (base.endsWith('_test.py')) {
    const src = base.slice(0, base.length - '_test.py'.length) + '.py';
    return nodePath.join(dir, src);
  }

  // Python: test_foo.py → foo.py
  if (base.startsWith('test_') && base.endsWith('.py')) {
    const src = base.slice('test_'.length);
    return nodePath.join(dir, src);
  }

  // TypeScript/JavaScript: foo.test.ts → foo.ts, foo.spec.js → foo.js, etc.
  const testSuffixMap: Record<string, string> = {
    '.test.tsx': '.tsx', '.test.ts': '.ts', '.test.jsx': '.jsx', '.test.js': '.js',
    '.spec.ts': '.ts', '.spec.js': '.js',
  };
  for (const [testSuffix, ext] of Object.entries(testSuffixMap)) {
    if (base.endsWith(testSuffix)) {
      const src = base.slice(0, base.length - testSuffix.length) + ext;
      return nodePath.join(dir, src);
    }
  }

  // Ruby: foo_spec.rb → foo.rb
  if (base.endsWith('_spec.rb')) {
    const src = base.slice(0, base.length - '_spec.rb'.length) + '.rb';
    return nodePath.join(dir, src);
  }

  return '';
}

// ============================================================================
// UNION-FIND
// ============================================================================

class UnionFind {
  private parent: Map<string, string> = new Map();

  add(key: string): void {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);
    }
  }

  find(key: string): string {
    const p = this.parent.get(key);
    if (p === undefined) {
      throw new Error(`UnionFind: key not found: ${key}`);
    }
    if (p === key) return key;
    // Path compression.
    const root = this.find(p);
    this.parent.set(key, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      this.parent.set(rb, ra);
    }
  }
}

// ============================================================================
// INTERNAL TYPES
// ============================================================================

/** Associates a SymbolChange with the file it came from. */
interface IndexedChange {
  change: SymbolChange;
  filePath: string;
}
