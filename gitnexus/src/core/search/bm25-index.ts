/**
 * Full-Text Search via LadybugDB FTS
 *
 * Uses LadybugDB's built-in full-text search indexes for keyword-based search.
 * Always reads from the database (no cached state to drift).
 */

import { queryFTS } from '../lbug/lbug-adapter.js';

export interface BM25SearchResult {
  filePath: string;
  score: number;
  rank: number;
}

/**
 * Execute a single FTS query via a custom executor (for MCP connection pool).
 * Returns the same shape as core queryFTS (from LadybugDB adapter).
 */
async function queryFTSViaExecutor(
  executor: (cypher: string) => Promise<any[]>,
  tableName: string,
  indexName: string,
  query: string,
  limit: number,
): Promise<{ results: Array<{ filePath: string; score: number }>; error?: string }> {
  // Escape single quotes and backslashes to prevent Cypher injection
  const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', '${escapedQuery}', conjunctive := false)
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;
  try {
    const rows = await executor(cypher);
    return {
      results: rows.map((row: any) => {
        const node = row.node || row[0] || {};
        const score = row.score ?? row[1] ?? 0;
        return {
          filePath: node.filePath || '',
          score: typeof score === 'number' ? score : parseFloat(score) || 0,
        };
      }),
    };
  } catch (e: any) {
    const msg = e?.message || String(e);
    return { results: [], error: `FTS query on ${tableName}/${indexName} failed: ${msg}` };
  }
}

/**
 * Search using LadybugDB's built-in FTS (always fresh, reads from disk)
 *
 * Queries multiple node tables (File, Function, Class, Method) in parallel
 * and merges results by filePath, summing scores for the same file.
 *
 * @param query - Search query string
 * @param limit - Maximum results
 * @param repoId - If provided, queries will be routed via the MCP connection pool
 * @returns Ranked search results from FTS indexes
 */
export interface FTSSearchOutput {
  results: BM25SearchResult[];
  warnings: string[];
}

export const searchFTSFromLbug = async (
  query: string, limit: number = 20, repoId?: string,
): Promise<FTSSearchOutput> => {
  const warnings: string[] = [];

  const tables: Array<{ table: string; index: string }> = [
    { table: 'File', index: 'file_fts' },
    { table: 'Function', index: 'function_fts' },
    { table: 'Class', index: 'class_fts' },
    { table: 'Method', index: 'method_fts' },
    { table: 'Interface', index: 'interface_fts' },
  ];

  const allResults: Array<{ filePath: string; score: number }>[] = [];

  if (repoId) {
    const { executeQuery } = await import('../../mcp/core/lbug-adapter.js');
    const executor = (cypher: string) => executeQuery(repoId, cypher);
    for (const { table, index } of tables) {
      const out = await queryFTSViaExecutor(executor, table, index, query, limit);
      allResults.push(out.results);
      if (out.error) warnings.push(out.error);
    }
  } else {
    for (const { table, index } of tables) {
      try {
        allResults.push(await queryFTS(table, index, query, limit, false));
      } catch (e: any) {
        allResults.push([]);
        warnings.push(`FTS query on ${table}/${index} failed: ${e?.message || e}`);
      }
    }
  }

  // Merge results by filePath, summing scores for same file
  const merged = new Map<string, { filePath: string; score: number }>();
  for (const results of allResults) {
    for (const r of results) {
      const existing = merged.get(r.filePath);
      if (existing) {
        existing.score += r.score;
      } else {
        merged.set(r.filePath, { filePath: r.filePath, score: r.score });
      }
    }
  }

  // Sort by score descending and add rank
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    results: sorted.map((r, index) => ({
      filePath: r.filePath,
      score: r.score,
      rank: index + 1,
    })),
    warnings,
  };
};
