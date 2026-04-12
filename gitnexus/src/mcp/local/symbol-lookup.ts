/**
 * Symbol Lookup — shared 4-tier symbol resolution
 *
 * Used by the `context` tool handler.
 * Tiers: exact QN → QN suffix → name → fuzzy suggestions
 */

import { executeParameterized } from '../core/lbug-adapter.js';

/** Columns returned by every successful symbol SELECT */
const NODE_SELECT = `
  RETURN n.id AS qn, n.name AS name, labels(n)[0] AS label,
         n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine,
         n.startColumn AS startColumn, n.description AS description
  LIMIT 10
`;

/**
 * Symbol kind priority for disambiguation.
 * Lower number = higher priority.
 * Type definitions and their members are preferred over local variables/parameters.
 */
const KIND_PRIORITY: Record<string, number> = {
  Interface: 1,
  TypeAlias: 1,
  Class: 1,
  Enum: 1,
  Property: 2,
  Field: 2,
  EnumMember: 2,
  Function: 3,
  Method: 3,
  Variable: 4,
  Parameter: 5,
};
const DEFAULT_PRIORITY = 6;

/** Sort symbol rows by kind priority, then by file path */
export function sortByKindPriority<T extends { label?: string; filePath?: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    const aLabel = a.label ?? '';
    const bLabel = b.label ?? '';
    const aPriority = KIND_PRIORITY[aLabel] ?? DEFAULT_PRIORITY;
    const bPriority = KIND_PRIORITY[bLabel] ?? DEFAULT_PRIORITY;
    if (aPriority !== bPriority) return aPriority - bPriority;
    // Secondary sort by file path for stability
    return (a.filePath ?? '').localeCompare(b.filePath ?? '');
  });
}

/** Fuzzy suggestion row shape */
export interface SymbolSuggestion {
  name: string;
  qn: string;
  label: string;
  file: string;
}

/** Resolved symbol data */
export interface ResolvedSymbol {
  name: string;
  qn: string;
  label: string;
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  description?: string;
}

/** Result when symbol is found */
export interface SymbolFound {
  kind: 'found';
  node: ResolvedSymbol;
  /** Other matches when tier 2/3 returned multiple rows */
  alternatives?: SymbolSuggestion[];
  match_method: string;
}

/** Result when no exact match — returns fuzzy suggestions */
export interface SymbolSuggestions {
  kind: 'suggestions';
  match_method: 'suggestions';
  alternatives: SymbolSuggestion[];
}

export type SymbolLookupResult = SymbolFound | SymbolSuggestions;

/** Logged error helper — keeps catch blocks from swallowing errors silently */
function logErr(ctx: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`GitNexus [${ctx}]: ${msg}`);
}

/**
 * Extract the logical node label from a GitNexus QN string.
 * IDs are "Label:path:name:line" — take everything before the first ":".
 */
function labelFromQn(qn: string): string {
  if (!qn) return '';
  const i = qn.indexOf(':');
  return i > 0 ? qn.slice(0, i) : '';
}

/**
 * 5-tier symbol lookup.
 *
 * Tier 1 — exact QN (`n.id = qn`)
 * Tier 2 — dotted syntax: `Parent.child` → QN suffix `:Parent.child`
 * Tier 3 — simple suffix (`n.id ENDS WITH .qn`)
 * Tier 4 — name match (`n.name = qn`)
 * Tier 5 — fuzzy: `n.name CONTAINS fragment`, returns suggestions only (no node)
 *
 * @param repoId  LadybugDB repo ID
 * @param qn      The qualified name or symbol name supplied by the caller
 */
export async function findSymbol(repoId: string, qn: string): Promise<SymbolLookupResult> {
  let rows: any[] = [];
  let matchMethod = 'exact_qn';

  // Tier 1: exact QN
  try {
    rows = await executeParameterized(repoId,
      `MATCH (n) WHERE n.id = $qn ${NODE_SELECT}`,
      { qn });
  } catch (e) { logErr('findSymbol:exact_qn', e); }

  // Tier 2: dotted syntax - e.g., "Interface.property" or "Class.method"
  // QN format is "Label:path:Parent.child", so we search for ":Parent.child" suffix
  if (rows.length === 0 && qn.includes('.') && !qn.includes(':') && !qn.includes('/')) {
    matchMethod = 'dotted_syntax';
    const colonSuffix = `:${qn}`;
    try {
      rows = await executeParameterized(repoId,
        `MATCH (n) WHERE n.id ENDS WITH $suffix ${NODE_SELECT}`,
        { suffix: colonSuffix });
    } catch (e) { logErr('findSymbol:dotted_syntax', e); }
  }

  // Tier 3: simple QN suffix (for single names like "myFunction")
  if (rows.length === 0) {
    matchMethod = 'qn_suffix';
    const suffix = qn.startsWith('.') ? qn : `.${qn}`;
    try {
      rows = await executeParameterized(repoId,
        `MATCH (n) WHERE n.id ENDS WITH $suffix ${NODE_SELECT}`,
        { suffix });
    } catch (e) { logErr('findSymbol:qn_suffix', e); }
  }

  // Tier 4: name match
  if (rows.length === 0) {
    matchMethod = 'name';
    try {
      rows = await executeParameterized(repoId,
        `MATCH (n) WHERE n.name = $name ${NODE_SELECT}`,
        { name: qn });
    } catch (e) { logErr('findSymbol:name', e); }
  }

  // Tier 5: fuzzy suggestions
  if (rows.length === 0) {
    let suggestions: any[] = [];
    try {
      suggestions = await executeParameterized(repoId,
        `MATCH (n) WHERE n.name CONTAINS $fragment
         AND NOT labels(n)[0] IN ['File', 'Folder', 'Community', 'Process']
         RETURN n.id AS qn, n.name AS name, labels(n)[0] AS label, n.filePath AS file
         LIMIT 10`,
        { fragment: qn.split('.').pop() ?? qn });
    } catch (e) { logErr('findSymbol:suggestions', e); }

    return {
      kind: 'suggestions',
      match_method: 'suggestions',
      alternatives: suggestions.map(r => ({
        name: r.name ?? r[1],
        qn: r.qn ?? r[0],
        label: labelFromQn(r.qn ?? r[0]),
        file: r.file ?? r[3],
      })),
    };
  }

  // Normalize rows to a consistent format for sorting
  // Always extract label from QN (node ID) since labels(n)[0] is unreliable in LadybugDB
  const normalizedRows = rows.map(r => {
    const qn = r.qn ?? r[0];
    return {
      qn,
      name: r.name ?? r[1],
      label: labelFromQn(qn), // Always extract from ID, labels(n)[0] returns physical table name
      filePath: r.filePath ?? r[3],
      startLine: r.startLine ?? r[4],
      endLine: r.endLine ?? r[5],
      startColumn: r.startColumn ?? r[6],
      description: r.description ?? r[7],
    };
  });

  // Sort by kind priority (type definitions > members > functions > variables > parameters)
  const sortedRows = sortByKindPriority(normalizedRows);

  // Build resolved node from first (highest priority) row
  const row = sortedRows[0];
  const node: ResolvedSymbol = {
    name: row.name,
    qn: row.qn,
    label: row.label,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    startColumn: row.startColumn,
    description: row.description,
  };

  const alternatives: SymbolSuggestion[] | undefined = sortedRows.length > 1
    ? sortedRows.slice(1).map(r => ({
        name: r.name,
        qn: r.qn,
        label: r.label,
        file: r.filePath,
      }))
    : undefined;

  return { kind: 'found', node, alternatives, match_method: matchMethod };
}
