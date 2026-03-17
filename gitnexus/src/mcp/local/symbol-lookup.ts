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
         n.description AS description
  LIMIT 10
`;

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
 * 4-tier symbol lookup.
 *
 * Tier 1 — exact QN (`n.id = qn`)
 * Tier 2 — QN suffix (`n.id ENDS WITH .qn`)
 * Tier 3 — name match (`n.name = qn`)
 * Tier 4 — fuzzy: `n.name CONTAINS fragment`, returns suggestions only (no node)
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

  // Tier 2: QN suffix
  if (rows.length === 0) {
    matchMethod = 'qn_suffix';
    const suffix = qn.startsWith('.') ? qn : `.${qn}`;
    try {
      rows = await executeParameterized(repoId,
        `MATCH (n) WHERE n.id ENDS WITH $suffix ${NODE_SELECT}`,
        { suffix });
    } catch (e) { logErr('findSymbol:qn_suffix', e); }
  }

  // Tier 3: name match
  if (rows.length === 0) {
    matchMethod = 'name';
    try {
      rows = await executeParameterized(repoId,
        `MATCH (n) WHERE n.name = $name ${NODE_SELECT}`,
        { name: qn });
    } catch (e) { logErr('findSymbol:name', e); }
  }

  // Tier 4: fuzzy suggestions
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

  // Build resolved node from first row
  const row = rows[0];
  const node: ResolvedSymbol = {
    name: row.name ?? row[1],
    qn: row.qn ?? row[0],
    label: labelFromQn(row.qn ?? row[0]),
    filePath: row.filePath ?? row[3],
    startLine: row.startLine ?? row[4],
    endLine: row.endLine ?? row[5],
    description: row.description ?? row[6],
  };

  const alternatives: SymbolSuggestion[] | undefined = rows.length > 1
    ? rows.slice(1).map(r => ({
        name: r.name ?? r[1],
        qn: r.qn ?? r[0],
        label: labelFromQn(r.qn ?? r[0]),
        file: r.filePath ?? r[3],
      }))
    : undefined;

  return { kind: 'found', node, alternatives, match_method: matchMethod };
}
