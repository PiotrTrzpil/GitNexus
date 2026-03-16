/**
 * Local Backend (Multi-Repo)
 * 
 * Provides tool implementations using local .gitnexus/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * LadybugDB connections are opened lazily per repo on first query.
 */

import fs from 'fs/promises';
import path from 'path';
import { initLbug, executeQuery, executeParameterized, closeLbug, isLbugReady } from '../core/lbug-adapter.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at MCP server startup — crashes on unsupported Node ABI versions (#89)
// git utilities available if needed
// import { isGitRepo, getCurrentCommit, getGitRoot } from '../../storage/git.js';
import {
  listRegisteredRepos,
  cleanupOldKuzuFiles,
  loadMeta,
  type RegistryEntry,
} from '../../storage/repo-manager.js';
// AI context generation is CLI-only (gitnexus analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';
import { diffFile } from '../../core/diff/semantic-differ.js';
import { planCommits, type CouplingEdge, type FileChangeSummary } from '../../core/diff/commit-planner.js';
import { readSourceWithContext, readFileLines, formatWithLineNumbers } from '../source-reader.js';

/**
 * Quick test-file detection for filtering impact results.
 * Matches common test file patterns across all supported languages.
 */
export function isTestFilePath(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') || p.includes('.spec.') ||
    p.includes('__tests__/') || p.includes('__mocks__/') ||
    p.includes('/test/') || p.includes('/tests/') ||
    p.includes('/testing/') || p.includes('/fixtures/') ||
    p.endsWith('_test.go') || p.endsWith('_test.py') ||
    p.endsWith('_spec.rb') || p.endsWith('_test.rb') || p.includes('/spec/') ||
    p.includes('/test_') || p.includes('/conftest.')
  );
}

/** Valid LadybugDB node labels for safe Cypher query construction */
export const VALID_NODE_LABELS = new Set([
  'File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement',
  'Community', 'Process', 'Struct', 'Enum', 'Macro', 'Typedef', 'Union',
  'Namespace', 'Trait', 'Impl', 'TypeAlias', 'Const', 'Static', 'Property',
  'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module',
]);

/** Valid relation types for impact analysis filtering */
export const VALID_RELATION_TYPES = new Set(['CALLS', 'HTTP_CALLS', 'ASYNC_CALLS', 'EMITS', 'SUBSCRIBES_TO', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']);

/** Regex to detect write operations in user-supplied Cypher queries */
export const CYPHER_WRITE_RE = /\b(CREATE|DELETE|SET|MERGE|REMOVE|DROP|ALTER|COPY|DETACH)\b/i;

/** Check if a Cypher query contains write operations */
export function isWriteQuery(query: string): boolean {
  return CYPHER_WRITE_RE.test(query);
}

/**
 * Group an array of items by their `filePath` field.
 *
 * Smart fallback: if every item comes from a different file (no actual grouping),
 * returns the flat array as-is with `file` inlined per item.
 * When items share files, returns `[{file, items: [...]}]`.
 *
 * Port of codebase-memory-mcp's groupItemsByFile.
 */
function groupByFile<T extends Record<string, any>>(
  items: T[],
  fileKey = 'filePath',
): any[] {
  if (items.length <= 1) return items;

  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const item of items) {
    const file = item[fileKey] ?? '';
    if (!groups.has(file)) {
      groups.set(file, []);
      order.push(file);
    }
    groups.get(file)!.push(item);
  }

  // If every item is from a different file, flat list is more compact
  if (groups.size === items.length) return items;

  return order.map(file => {
    const fileItems = groups.get(file)!;
    // Strip redundant filePath from each item since it's on the group
    const cleaned = fileItems.map(item => {
      const { [fileKey]: _, ...rest } = item;
      return rest;
    });
    return { file, items: cleaned };
  });
}

/**
 * Extract the logical label from a GitNexus node ID.
 * IDs are formatted as "Label:path:name:line" — the prefix before the first ":" is the label.
 * KuzuDB's labels(n)[0] returns the table name (always "CodeElement" etc.), not the logical label.
 */
function extractLabelFromQn(qn: string): string {
  if (!qn) return '';
  const colonIdx = qn.indexOf(':');
  return colonIdx > 0 ? qn.slice(0, colonIdx) : '';
}

/** Structured error logging for query failures — replaces empty catch blocks */
function logQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`GitNexus [${context}]: ${msg}`);
}

export interface CodebaseContext {
  projectName: string;
  stats: {
    fileCount: number;
    functionCount: number;
    communityCount: number;
    processCount: number;
  };
}

interface RepoHandle {
  id: string;          // unique key = repo name (basename)
  name: string;
  repoPath: string;
  storagePath: string;
  lbugPath: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RegistryEntry['stats'];
  loadedAt?: string;   // meta.indexedAt when DB was opened — for staleness detection
}

export class LocalBackend {
  private repos: Map<string, RepoHandle> = new Map();
  private contextCache: Map<string, CodebaseContext> = new Map();
  private initializedRepos: Set<string> = new Set();

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize from the global registry.
   * Returns true if at least one repo is available.
   */
  async init(): Promise<boolean> {
    await this.refreshRepos();
    return this.repos.size > 0;
  }

  /**
   * Re-read the global registry and update the in-memory repo map.
   * New repos are added, existing repos are updated, removed repos are pruned.
   * LadybugDB connections for removed repos are NOT closed (they idle-timeout naturally).
   */
  private async refreshRepos(): Promise<void> {
    const entries = await listRegisteredRepos({ validate: true });
    const freshIds = new Set<string>();

    for (const entry of entries) {
      const id = this.repoId(entry.name, entry.path);
      freshIds.add(id);

      const storagePath = entry.storagePath;
      const lbugPath = path.join(storagePath, 'lbug');

      // Clean up any leftover KuzuDB files from before the LadybugDB migration.
      // If kuzu exists but lbug doesn't, warn so the user knows to re-analyze.
      const kuzu = await cleanupOldKuzuFiles(storagePath);
      if (kuzu.found && kuzu.needsReindex) {
        console.error(`GitNexus: "${entry.name}" has a stale KuzuDB index. Run: gitnexus analyze ${entry.path}`);
      }

      const handle: RepoHandle = {
        id,
        name: entry.name,
        repoPath: entry.path,
        storagePath,
        lbugPath,
        indexedAt: entry.indexedAt,
        lastCommit: entry.lastCommit,
        stats: entry.stats,
      };

      this.repos.set(id, handle);

      // Build lightweight context (no LadybugDB needed)
      const s = entry.stats || {};
      this.contextCache.set(id, {
        projectName: entry.name,
        stats: {
          fileCount: s.files || 0,
          functionCount: s.nodes || 0,
          communityCount: s.communities || 0,
          processCount: s.processes || 0,
        },
      });
    }

    // Prune repos that no longer exist in the registry
    for (const id of this.repos.keys()) {
      if (!freshIds.has(id)) {
        this.repos.delete(id);
        this.contextCache.delete(id);
        this.initializedRepos.delete(id);
      }
    }
  }

  /**
   * Generate a stable repo ID from name + path.
   * If names collide, append a hash of the path.
   */
  private repoId(name: string, repoPath: string): string {
    const base = name.toLowerCase();
    // Check for name collision with a different path
    for (const [id, handle] of this.repos) {
      if (id === base && handle.repoPath !== path.resolve(repoPath)) {
        // Collision — use path hash
        const hash = Buffer.from(repoPath).toString('base64url').slice(0, 6);
        return `${base}-${hash}`;
      }
    }
    return base;
  }

  // ─── Repo Resolution ─────────────────────────────────────────────

  /**
   * Resolve which repo to use.
   * - If repoParam is given, match by name or path
   * - If only 1 repo, use it
   * - If 0 or multiple without param, throw with helpful message
   *
   * On a miss, re-reads the registry once in case a new repo was indexed
   * while the MCP server was running.
   */
  async resolveRepo(repoParam?: string): Promise<RepoHandle> {
    const result = this.resolveRepoFromCache(repoParam);
    if (result) return result;

    // Miss — refresh registry and try once more
    await this.refreshRepos();
    const retried = this.resolveRepoFromCache(repoParam);
    if (retried) return retried;

    // Still no match — throw with helpful message
    if (this.repos.size === 0) {
      throw new Error('No indexed repositories. Run: gitnexus analyze');
    }
    if (repoParam) {
      const names = [...this.repos.values()].map(h => h.name);
      throw new Error(`Repository "${repoParam}" not found. Available: ${names.join(', ')}`);
    }
    const names = [...this.repos.values()].map(h => h.name);
    throw new Error(
      `Multiple repositories indexed. Specify which one with the "repo" parameter. Available: ${names.join(', ')}`
    );
  }

  /**
   * Try to resolve a repo from the in-memory cache. Returns null on miss.
   */
  private resolveRepoFromCache(repoParam?: string): RepoHandle | null {
    if (this.repos.size === 0) return null;

    if (repoParam) {
      const paramLower = repoParam.toLowerCase();
      // Match by id
      if (this.repos.has(paramLower)) return this.repos.get(paramLower)!;
      // Match by name (case-insensitive)
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase() === paramLower) return handle;
      }
      // Match by path (substring)
      const resolved = path.resolve(repoParam);
      for (const handle of this.repos.values()) {
        if (handle.repoPath === resolved) return handle;
      }
      // Match by partial name
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase().includes(paramLower)) return handle;
      }
      return null;
    }

    if (this.repos.size === 1) {
      return this.repos.values().next().value!;
    }

    return null; // Multiple repos, no param — ambiguous
  }

  // ─── Lazy LadybugDB Init ────────────────────────────────────────────

  private async ensureInitialized(repoId: string): Promise<void> {
    // Always check the actual pool — the idle timer may have evicted the connection
    if (this.initializedRepos.has(repoId) && isLbugReady(repoId)) {
      // Staleness check: did `gitnexus analyze` rebuild the DB since we opened it?
      const handle = this.repos.get(repoId);
      if (handle?.loadedAt) {
        const meta = await loadMeta(handle.storagePath);
        if (meta?.indexedAt && meta.indexedAt !== handle.loadedAt) {
          // DB was rebuilt — close stale connection and fall through to re-init
          await closeLbug(repoId);
          this.initializedRepos.delete(repoId);
          this.contextCache.delete(repoId);
          handle.loadedAt = undefined;
        } else {
          return; // Still fresh
        }
      } else {
        return; // No loadedAt tracked yet (first run)
      }
    }

    const handle = this.repos.get(repoId);
    if (!handle) throw new Error(`Unknown repo: ${repoId}`);

    try {
      await initLbug(repoId, handle.lbugPath);
      this.initializedRepos.add(repoId);

      // Record when we loaded so we can detect staleness later
      const meta = await loadMeta(handle.storagePath);
      handle.loadedAt = meta?.indexedAt;
    } catch (err: any) {
      // If lock error, mark as not initialized so next call retries
      this.initializedRepos.delete(repoId);
      throw err;
    }
  }

  // ─── Public Getters ──────────────────────────────────────────────

  /**
   * Get context for a specific repo (or the single repo if only one).
   */
  getContext(repoId?: string): CodebaseContext | null {
    if (repoId && this.contextCache.has(repoId)) {
      return this.contextCache.get(repoId)!;
    }
    if (this.repos.size === 1) {
      return this.contextCache.values().next().value ?? null;
    }
    return null;
  }

  /**
   * List all registered repos with their metadata.
   * Re-reads the global registry so newly indexed repos are discovered
   * without restarting the MCP server.
   */
  async listRepos(): Promise<Array<{ name: string; path: string; indexedAt: string; lastCommit: string; stats?: any }>> {
    await this.refreshRepos();
    return [...this.repos.values()].map(h => ({
      name: h.name,
      path: h.repoPath,
      indexedAt: h.indexedAt,
      lastCommit: h.lastCommit,
      stats: h.stats,
    }));
  }

  // ─── Tool Dispatch ───────────────────────────────────────────────

  async callTool(method: string, params: any): Promise<any> {
    if (method === 'set_output_format') {
      const { setOutputFormat } = await import('../output-format.js');
      const fmt = setOutputFormat(params?.format);
      return `Output format set to ${fmt}`;
    }

    if (method === 'list_repos') {
      return this.listRepos();
    }

    // Resolve repo from optional param (re-reads registry on miss)
    const repo = await this.resolveRepo(params?.repo);

    switch (method) {
      case 'query':
        return this.query(repo, params);
      case 'cypher': {
        const raw = await this.cypher(repo, params);
        return this.formatCypherAsMarkdown(raw);
      }
      case 'context':
        return this.context(repo, params);
      case 'impact':
        return this.impact(repo, params);
      case 'detect_changes':
        return this.detectChanges(repo, params);
      case 'rename':
        return this.rename(repo, params);
      case 'semantic_diff':
        return this.semanticDiff(repo, params);
      case 'plan_commits':
        return this.planCommits(repo, params);
      case 'get_code_snippet':
        return this.getCodeSnippet(repo, params);
      case 'search_code':
        return this.searchCode(repo, params);
      case 'search_graph':
        return this.searchGraph(repo, params);
      case 'get_architecture':
        return this.getArchitecture(repo, params);
      case 'quality_query':
        return this.qualityQuery(repo, params);
      // Legacy aliases for backwards compatibility
      case 'search':
        return this.query(repo, params);
      case 'explore':
        return this.context(repo, { name: params?.name, ...params });
      case 'overview':
        return this.overview(repo, params);
      default:
        throw new Error(`Unknown tool: ${method}`);
    }
  }

  // ─── Semantic Diff ───────────────────────────────────────────────

  private async semanticDiff(repo: RepoHandle, params: {
    file_paths?: string[];
    ref?: string;
    breaking_only?: boolean;
  }): Promise<any> {
    const ref = params.ref ?? 'HEAD';
    const breakingOnly = params.breaking_only ?? false;

    // Determine files to diff: explicit list or all changed files via git
    let filePaths: string[] = params.file_paths ?? [];
    if (filePaths.length === 0) {
      // Fall back to git diff to find changed files
      try {
        const { execSync } = await import('child_process');
        const raw = execSync('git diff --name-only HEAD', { cwd: repo.repoPath }).toString();
        filePaths = raw.split('\n').map(l => l.trim()).filter(Boolean)
          .map(rel => path.join(repo.repoPath, rel));
      } catch (err) {
        console.warn(`[semanticDiff] git diff failed for ${repo.repoPath}: ${(err as Error).message}`);
        filePaths = [];
      }
    }

    if (filePaths.length === 0) {
      return { changes: [], summary: { total: 0, breaking: 0, byKind: {} } };
    }

    const allChanges = [];
    for (const fp of filePaths) {
      try {
        const fileChanges = await diffFile(repo.repoPath, fp, 'M', ref);
        allChanges.push(...fileChanges);
      } catch {
        // Non-fatal: skip unparseable or new files
      }
    }

    const filtered = breakingOnly ? allChanges.filter(c => c.isBreaking) : allChanges;

    const byKind: Record<string, number> = {};
    for (const c of filtered) {
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    }

    return {
      changes: filtered,
      summary: {
        total: filtered.length,
        breaking: filtered.filter(c => c.isBreaking).length,
        byKind,
      },
    };
  }

  // ─── Commit Planning ─────────────────────────────────────────────

  private async planCommits(repo: RepoHandle, params: {
    ref?: string;
    scope?: 'unstaged' | 'staged' | 'all';
  }): Promise<any> {
    const ref = params.ref ?? 'HEAD';

    // Get changed files for the chosen scope
    let filePaths: string[] = [];
    try {
      const { execSync } = await import('child_process');
      const scope = params.scope ?? 'unstaged';
      let gitCmd: string;
      if (scope === 'staged') {
        gitCmd = 'git diff --cached --name-only';
      } else if (scope === 'all') {
        gitCmd = 'git diff HEAD --name-only';
      } else {
        gitCmd = 'git diff --name-only';
      }
      const raw = execSync(gitCmd, { cwd: repo.repoPath }).toString();
      filePaths = raw.split('\n').map(l => l.trim()).filter(Boolean)
        .map(rel => path.join(repo.repoPath, rel));
    } catch (err) {
      console.warn(`[planCommits] git diff failed for ${repo.repoPath}: ${(err as Error).message}`);
      filePaths = [];
    }

    if (filePaths.length === 0) {
      return { groups: [], ungrouped: [] };
    }

    // Collect symbol changes via semantic diff, grouped by file
    const fileSummaries: FileChangeSummary[] = [];
    for (const fp of filePaths) {
      try {
        const fileChanges = await diffFile(repo.repoPath, fp, 'M', ref);
        if (fileChanges.length > 0) {
          fileSummaries.push({ path: fp, changes: fileChanges });
        }
      } catch {
        // Non-fatal: skip unparseable files
      }
    }

    if (fileSummaries.length === 0) {
      return { groups: [], ungrouped: [] };
    }

    // Fetch call graph edges for coupling signal
    let couplings: CouplingEdge[] = [];
    try {
      await this.ensureInitialized(repo.id);
      const rows = await this.cypher(repo, {
        query: `MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b) WHERE r.confidence >= 0.7 RETURN a.id AS sourceQN, b.id AS targetQN LIMIT 2000`,
      });
      couplings = (rows as any[]).map((r: any) => ({ fromQN: r.sourceQN, toQN: r.targetQN, type: 'CALLS' }));
    } catch {
      // Non-fatal: plan without graph edges
    }

    return planCommits(fileSummaries, couplings);
  }

  // ─── Code Snippet ─────────────────────────────────────────────────

  private async getCodeSnippet(repo: RepoHandle, params: {
    qualified_name: string;
    context_lines?: number;
    include_neighbors?: boolean;
    repo?: string;
  }): Promise<any> {
    if (!params.qualified_name?.trim()) {
      return { error: 'qualified_name parameter is required and cannot be empty.' };
    }

    await this.ensureInitialized(repo.id);

    const qn = params.qualified_name.trim();
    const contextLines = params.context_lines ?? 3;
    const includeNeighbors = params.include_neighbors ?? false;

    // Shared node fetch query
    const nodeSelectClause = `
      RETURN n.id AS qn, n.name AS name, labels(n)[0] AS label,
             n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine,
             n.description AS description
      LIMIT 10
    `;

    // Tier 1: Exact QN match
    let rows: any[] = [];
    let matchMethod: string = 'exact_qn';
    try {
      rows = await executeParameterized(repo.id,
        `MATCH (n) WHERE n.id = $qn ${nodeSelectClause}`,
        { qn });
    } catch (e) { logQueryError('get_code_snippet:exact_qn', e); }

    // Tier 2: QN suffix match
    if (rows.length === 0) {
      matchMethod = 'qn_suffix';
      const suffix = qn.startsWith('.') ? qn : `.${qn}`;
      try {
        rows = await executeParameterized(repo.id,
          `MATCH (n) WHERE n.id ENDS WITH $suffix ${nodeSelectClause}`,
          { suffix });
      } catch (e) { logQueryError('get_code_snippet:qn_suffix', e); }
    }

    // Tier 3: Name match
    if (rows.length === 0) {
      matchMethod = 'name';
      try {
        rows = await executeParameterized(repo.id,
          `MATCH (n) WHERE n.name = $name ${nodeSelectClause}`,
          { name: qn });
      } catch (e) { logQueryError('get_code_snippet:name', e); }
    }

    // Tier 4: Fuzzy suggestions — return top-10 name matches (exclude infrastructure nodes)
    if (rows.length === 0) {
      matchMethod = 'suggestions';
      let suggestions: any[] = [];
      try {
        suggestions = await executeParameterized(repo.id,
          `MATCH (n) WHERE n.name CONTAINS $fragment
           AND NOT labels(n)[0] IN ['File', 'Folder', 'Community', 'Process']
           RETURN n.id AS qn, n.name AS name, labels(n)[0] AS label, n.filePath AS file
           LIMIT 10`,
          { fragment: qn.split('.').pop() ?? qn });
      } catch (e) { logQueryError('get_code_snippet:suggestions', e); }
      return {
        match_method: 'suggestions',
        alternatives: suggestions.map(r => ({
          name: r.name ?? r[1],
          qn: r.qn ?? r[0],
          label: extractLabelFromQn(r.qn ?? r[0]),
          file: r.file ?? r[3],
        })),
      };
    }

    // If multiple matches, pick the first but surface alternatives
    const node = rows[0];
    const nodeName: string = node.name ?? node[1];
    const nodeQn: string = node.qn ?? node[0];
    const nodeLabel: string = extractLabelFromQn(node.qn ?? node[0]);
    const nodeFilePath: string = node.filePath ?? node[3];
    const startLine: number = node.startLine ?? node[4];
    const endLine: number = node.endLine ?? node[5];
    const description: string | undefined = node.description ?? node[6];

    const alternatives = rows.length > 1
      ? rows.slice(1).map(r => ({
          name: r.name ?? r[1],
          qn: r.qn ?? r[0],
          label: extractLabelFromQn(r.qn ?? r[0]),
          file: r.filePath ?? r[3],
        }))
      : undefined;

    // Read source from disk
    let source: string = '';
    try {
      const result = await readSourceWithContext(repo.repoPath, nodeFilePath, startLine, endLine, contextLines);
      if (result) {
        source = result.source;
      }
    } catch (e) { logQueryError('get_code_snippet:read_source', e); }

    // Count callers (inbound CALLS edges)
    let callers = 0;
    let callerNames: string[] | undefined;
    try {
      const callerRows = await executeParameterized(repo.id,
        `MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(n {id: $qn})
         RETURN caller.name AS name, COUNT(*) AS cnt`,
        { qn: nodeQn });
      callers = callerRows.length;
      if (includeNeighbors) {
        callerNames = callerRows.map(r => r.name ?? r[0]).filter(Boolean);
      }
    } catch (e) { logQueryError('get_code_snippet:callers', e); }

    // Count callees (outbound CALLS edges)
    let callees = 0;
    let calleeNames: string[] | undefined;
    try {
      const calleeRows = await executeParameterized(repo.id,
        `MATCH (n {id: $qn})-[r:CodeRelation {type: 'CALLS'}]->(callee)
         RETURN callee.name AS name, COUNT(*) AS cnt`,
        { qn: nodeQn });
      callees = calleeRows.length;
      if (includeNeighbors) {
        calleeNames = calleeRows.map(r => r.name ?? r[0]).filter(Boolean);
      }
    } catch (e) { logQueryError('get_code_snippet:callees', e); }

    return {
      name: nodeName,
      qn: nodeQn,
      label: nodeLabel,
      file: nodeFilePath,
      lines: `${startLine}-${endLine}`,
      source,
      ...(description ? { description } : {}),
      callers,
      callees,
      ...(includeNeighbors && callerNames ? { caller_names: callerNames } : {}),
      ...(includeNeighbors && calleeNames ? { callee_names: calleeNames } : {}),
      match_method: matchMethod,
      ...(alternatives ? { alternatives } : {}),
    };
  }

  /**
   * search_code — text/regex search across indexed files.
   *
   * 1. Fetches indexed file paths from KuzuDB (File nodes)
   * 2. Optionally filters by file_pattern glob (supports * and ?)
   * 3. Reads each file from disk line-by-line
   * 4. Matches via RegExp or string.includes()
   * 5. Paginates results and attaches context lines
   */
  private async searchCode(repo: RepoHandle, params: {
    pattern: string;
    file_pattern?: string;
    max_results?: number;
    offset?: number;
    context_lines?: number;
    regex?: boolean;
    case_sensitive?: boolean;
    repo?: string;
  }): Promise<any> {
    if (!params.pattern?.trim()) {
      return { error: 'pattern parameter is required and cannot be empty.' };
    }

    await this.ensureInitialized(repo.id);

    const pattern = params.pattern.trim();
    const limit = Math.min(params.max_results ?? 20, 100);
    const offset = params.offset ?? 0;
    const contextLines = params.context_lines ?? 2;
    const useRegex = params.regex ?? false;
    const caseSensitive = params.case_sensitive ?? true;

    // Build matcher function
    let matcher: (line: string) => boolean;
    if (useRegex) {
      const flags = caseSensitive ? '' : 'i';
      let re: RegExp;
      try {
        re = new RegExp(pattern, flags);
      } catch (e) {
        return { error: `Invalid regex: ${(e as Error).message}` };
      }
      matcher = (line: string) => re.test(line);
    } else if (caseSensitive) {
      matcher = (line: string) => line.includes(pattern);
    } else {
      const lower = pattern.toLowerCase();
      matcher = (line: string) => line.toLowerCase().includes(lower);
    }

    // Get indexed file paths from KuzuDB
    let filePaths: string[] = [];
    try {
      const rows = await executeQuery(repo.id, `MATCH (f:File) RETURN f.filePath AS fp`);
      filePaths = rows.map((r: any) => r.fp ?? r[0]).filter(Boolean);
    } catch (e) {
      logQueryError('search_code:file-list', e);
      return { error: 'Failed to retrieve indexed file list.' };
    }

    // Exclude non-source files by default (docs, configs, generated files)
    const NON_SOURCE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.lock', '.csv', '.svg', '.html', '.css']);
    filePaths = filePaths.filter(p => {
      const dot = p.lastIndexOf('.');
      if (dot < 0) return true;
      return !NON_SOURCE_EXTENSIONS.has(p.slice(dot).toLowerCase());
    });

    // Filter by file_pattern if provided
    if (params.file_pattern) {
      const fp = params.file_pattern;
      // Convert simple glob to regex: * → .*, ? → .
      const globRe = new RegExp('^' + fp.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      filePaths = filePaths.filter(p => {
        const basename = p.split('/').pop() ?? p;
        return globRe.test(p) || globRe.test(basename);
      });
    }

    // Scan files — collect all matches, then paginate
    const allMatches: Array<{ file: string; line: number; content: string; lines: string[] }> = [];

    for (const filePath of filePaths) {
      const lines = await readFileLines(repo.repoPath, filePath);
      if (!lines) continue;

      for (let i = 0; i < lines.length; i++) {
        if (matcher(lines[i])) {
          allMatches.push({
            file: filePath,
            line: i + 1,
            content: lines[i].trimEnd().slice(0, 200),
            lines, // keep ref for context extraction
          });
        }
      }
    }

    const totalMatches = allMatches.length;
    const page = allMatches.slice(offset, offset + limit);

    // Build response matches with optional context lines
    const matches = page.map(m => {
      const entry: any = {
        file: m.file,
        line: m.line,
        content: m.content,
      };
      if (contextLines > 0) {
        const firstCtx = Math.max(0, m.line - 1 - contextLines);
        const lastCtx = Math.min(m.lines.length, m.line + contextLines);
        const slice = m.lines.slice(firstCtx, lastCtx);
        entry.context = formatWithLineNumbers(slice, firstCtx + 1).split('\n');
      }
      return entry;
    });

    return {
      pattern,
      total_matches: totalMatches,
      limit,
      offset,
      has_more: offset + limit < totalMatches,
      matches,
    };
  }

  // ─── Tool Implementations ────────────────────────────────────────

  /**
   * Query tool — process-grouped search.
   * 
   * 1. Hybrid search (BM25 + semantic) to find matching symbols
   * 2. Trace each match to its process(es) via STEP_IN_PROCESS
   * 3. Group by process, rank by aggregate relevance + internal cluster cohesion
   * 4. Return: { processes, process_symbols, definitions }
   */
  private async query(repo: RepoHandle, params: {
    query: string;
    task_context?: string;
    goal?: string;
    limit?: number;
    max_symbols?: number;
    include_content?: boolean;
  }): Promise<any> {
    if (!params.query?.trim()) {
      return { error: 'query parameter is required and cannot be empty.' };
    }
    
    await this.ensureInitialized(repo.id);
    
    const processLimit = params.limit || 5;
    const maxSymbolsPerProcess = params.max_symbols || 10;
    const includeContent = params.include_content ?? false;
    const searchQuery = params.query.trim();
    
    // Step 1: Run hybrid search to get matching symbols
    const searchLimit = processLimit * maxSymbolsPerProcess; // fetch enough raw results
    const [bm25Results, semanticResults] = await Promise.all([
      this.bm25Search(repo, searchQuery, searchLimit),
      this.semanticSearch(repo, searchQuery, searchLimit),
    ]);
    
    // Merge via reciprocal rank fusion
    const scoreMap = new Map<string, { score: number; data: any }>();
    
    for (let i = 0; i < bm25Results.length; i++) {
      const result = bm25Results[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (60 + i);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }
    
    for (let i = 0; i < semanticResults.length; i++) {
      const result = semanticResults[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (60 + i);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }
    
    const merged = Array.from(scoreMap.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, searchLimit);
    
    // Step 2: For each match with a nodeId, trace to process(es)
    const processMap = new Map<string, { id: string; label: string; heuristicLabel: string; processType: string; stepCount: number; totalScore: number; cohesionBoost: number; symbols: any[] }>();
    const definitions: any[] = []; // standalone symbols not in any process
    
    for (const [_, item] of merged) {
      const sym = item.data;
      if (!sym.nodeId) {
        // File-level results go to definitions
        definitions.push({
          name: sym.name,
          type: sym.type || 'File',
          filePath: sym.filePath,
        });
        continue;
      }
      
      // Find processes this symbol participates in
      let processRows: any[] = [];
      try {
        processRows = await executeParameterized(repo.id, `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `, { nodeId: sym.nodeId });
      } catch (e) { logQueryError('query:process-lookup', e); }

      // Get cluster membership + cohesion (cohesion used as internal ranking signal)
      let cohesion = 0;
      let module: string | undefined;
      try {
        const cohesionRows = await executeParameterized(repo.id, `
          MATCH (n {id: $nodeId})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.cohesion AS cohesion, c.heuristicLabel AS module
          LIMIT 1
        `, { nodeId: sym.nodeId });
        if (cohesionRows.length > 0) {
          cohesion = (cohesionRows[0].cohesion ?? cohesionRows[0][0]) || 0;
          module = cohesionRows[0].module ?? cohesionRows[0][1];
        }
      } catch (e) { logQueryError('query:cluster-info', e); }

      // Optionally fetch content
      let content: string | undefined;
      let diskSource: string | undefined;
      if (includeContent) {
        try {
          const contentRows = await executeParameterized(repo.id, `
            MATCH (n {id: $nodeId})
            RETURN n.content AS content
          `, { nodeId: sym.nodeId });
          if (contentRows.length > 0) {
            content = contentRows[0].content ?? contentRows[0][0];
          }
        } catch (e) { logQueryError('query:content-fetch', e); }

        // Also read disk-fresh source with context lines
        if (sym.filePath && sym.startLine != null && sym.endLine != null) {
          try {
            const diskResult = await readSourceWithContext(repo.repoPath, sym.filePath, sym.startLine, sym.endLine, 2);
            if (diskResult) {
              diskSource = diskResult.source;
            }
          } catch (e) { logQueryError('query:disk-source', e); }
        }
      }

      const symbolEntry = {
        id: sym.nodeId,
        name: sym.name,
        type: sym.type,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine,
        ...(module ? { module } : {}),
        ...(includeContent && content ? { content } : {}),
        ...(includeContent && diskSource ? { source: diskSource } : {}),
      };
      
      if (processRows.length === 0) {
        // Symbol not in any process — goes to definitions
        definitions.push(symbolEntry);
      } else {
        // Add to each process it belongs to
        for (const row of processRows) {
          const pid = row.pid ?? row[0];
          const label = row.label ?? row[1];
          const hLabel = row.heuristicLabel ?? row[2];
          const pType = row.processType ?? row[3];
          const stepCount = row.stepCount ?? row[4];
          const step = row.step ?? row[5];
          
          if (!processMap.has(pid)) {
            processMap.set(pid, {
              id: pid,
              label,
              heuristicLabel: hLabel,
              processType: pType,
              stepCount,
              totalScore: 0,
              cohesionBoost: 0,
              symbols: [],
            });
          }
          
          const proc = processMap.get(pid)!;
          proc.totalScore += item.score;
          proc.cohesionBoost = Math.max(proc.cohesionBoost, cohesion);
          proc.symbols.push({
            ...symbolEntry,
            process_id: pid,
            step_index: step,
          });
        }
      }
    }
    
    // Step 3: Rank processes by aggregate score + internal cohesion boost
    const rankedProcesses = Array.from(processMap.values())
      .map(p => ({
        ...p,
        priority: p.totalScore + (p.cohesionBoost * 0.1), // cohesion as subtle ranking signal
      }))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, processLimit);
    
    // Step 4: Build response
    const processes = rankedProcesses.map(p => ({
      id: p.id,
      summary: p.heuristicLabel || p.label,
      priority: Math.round(p.priority * 1000) / 1000,
      symbol_count: p.symbols.length,
      process_type: p.processType,
      step_count: p.stepCount,
    }));
    
    const processSymbols = rankedProcesses.flatMap(p =>
      p.symbols.slice(0, maxSymbolsPerProcess).map(s => ({
        ...s,
        // remove internal fields
      }))
    );
    
    // Deduplicate process_symbols by id
    const seen = new Set<string>();
    const dedupedSymbols = processSymbols.filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    
    return {
      processes,
      process_symbols: groupByFile(dedupedSymbols),
      definitions: groupByFile(definitions.slice(0, 20)), // cap standalone definitions
    };
  }

  /**
   * BM25 keyword search helper - uses LadybugDB FTS for always-fresh results
   */
  private async bm25Search(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    const { searchFTSFromLbug } = await import('../../core/search/bm25-index.js');
    let bm25Results;
    try {
      bm25Results = await searchFTSFromLbug(query, limit, repo.id);
    } catch (err: any) {
      console.error('GitNexus: BM25/FTS search failed (FTS indexes may not exist) -', err.message);
      return [];
    }
    
    const results: any[] = [];
    
    for (const bm25Result of bm25Results) {
      const fullPath = bm25Result.filePath;
      try {
        const symbols = await executeParameterized(repo.id, `
          MATCH (n)
          WHERE n.filePath = $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
          LIMIT 3
        `, { filePath: fullPath });
        
        if (symbols.length > 0) {
          for (const sym of symbols) {
            results.push({
              nodeId: sym.id || sym[0],
              name: sym.name || sym[1],
              type: sym.type || sym[2],
              filePath: sym.filePath || sym[3],
              startLine: sym.startLine || sym[4],
              endLine: sym.endLine || sym[5],
              bm25Score: bm25Result.score,
            });
          }
        } else {
          const fileName = fullPath.split('/').pop() || fullPath;
          results.push({
            name: fileName,
            type: 'File',
            filePath: bm25Result.filePath,
            bm25Score: bm25Result.score,
          });
        }
      } catch {
        const fileName = fullPath.split('/').pop() || fullPath;
        results.push({
          name: fileName,
          type: 'File',
          filePath: bm25Result.filePath,
          bm25Score: bm25Result.score,
        });
      }
    }
    
    return results;
  }

  /**
   * Semantic vector search helper
   */
  private async semanticSearch(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    try {
      // Check if embedding table exists before loading the model (avoids heavy model init when embeddings are off)
      const tableCheck = await executeQuery(repo.id, `MATCH (e:CodeEmbedding) RETURN COUNT(*) AS cnt LIMIT 1`);
      if (!tableCheck.length || (tableCheck[0].cnt ?? tableCheck[0][0]) === 0) return [];

      const { embedQuery, getEmbeddingDims } = await import('../core/embedder.js');
      const queryVec = await embedQuery(query);
      const dims = getEmbeddingDims();
      const queryVecStr = `[${queryVec.join(',')}]`;
      
      const vectorQuery = `
        CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 
          CAST(${queryVecStr} AS FLOAT[${dims}]), ${limit})
        YIELD node AS emb, distance
        WITH emb, distance
        WHERE distance < 0.6
        RETURN emb.nodeId AS nodeId, distance
        ORDER BY distance
      `;
      
      const embResults = await executeQuery(repo.id, vectorQuery);
      
      if (embResults.length === 0) return [];
      
      const results: any[] = [];
      
      for (const embRow of embResults) {
        const nodeId = embRow.nodeId ?? embRow[0];
        const distance = embRow.distance ?? embRow[1];
        
        const labelEndIdx = nodeId.indexOf(':');
        const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
        
        // Validate label against known node types to prevent Cypher injection
        if (!VALID_NODE_LABELS.has(label)) continue;
        
        try {
          const nodeQuery = label === 'File'
            ? `MATCH (n:File {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`
            : `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;

          const nodeRows = await executeParameterized(repo.id, nodeQuery, { nodeId });
          if (nodeRows.length > 0) {
            const nodeRow = nodeRows[0];
            results.push({
              nodeId,
              name: nodeRow.name ?? nodeRow[0] ?? '',
              type: label,
              filePath: nodeRow.filePath ?? nodeRow[1] ?? '',
              distance,
              startLine: label !== 'File' ? (nodeRow.startLine ?? nodeRow[2]) : undefined,
              endLine: label !== 'File' ? (nodeRow.endLine ?? nodeRow[3]) : undefined,
            });
          }
        } catch {}
      }
      
      return results;
    } catch {
      // Expected when embeddings are disabled — silently fall back to BM25-only
      return [];
    }
  }

  async executeCypher(repoName: string, query: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    return this.cypher(repo, { query });
  }

  private async cypher(repo: RepoHandle, params: { query: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!isLbugReady(repo.id)) {
      return { error: 'LadybugDB not ready. Index may be corrupted.' };
    }

    // Block write operations (defense-in-depth — DB is already read-only)
    if (CYPHER_WRITE_RE.test(params.query)) {
      return { error: 'Write operations (CREATE, DELETE, SET, MERGE, REMOVE, DROP, ALTER, COPY, DETACH) are not allowed. The knowledge graph is read-only.' };
    }

    try {
      const result = await executeQuery(repo.id, params.query);
      return result;
    } catch (err: any) {
      return { error: err.message || 'Query failed' };
    }
  }

  /**
   * Format raw Cypher result rows as a markdown table for LLM readability.
   * Falls back to raw result if rows aren't tabular objects.
   */
  private formatCypherAsMarkdown(result: any): any {
    if (!Array.isArray(result) || result.length === 0) return result;

    const firstRow = result[0];
    if (typeof firstRow !== 'object' || firstRow === null) return result;

    const keys = Object.keys(firstRow);
    if (keys.length === 0) return result;

    const header = '| ' + keys.join(' | ') + ' |';
    const separator = '| ' + keys.map(() => '---').join(' | ') + ' |';
    const dataRows = result.map((row: any) =>
      '| ' + keys.map(k => {
        const v = row[k];
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
      }).join(' | ') + ' |'
    );

    return {
      markdown: [header, separator, ...dataRows].join('\n'),
      row_count: result.length,
    };
  }

  /**
   * Aggregate same-named clusters: group by heuristicLabel, sum symbols,
   * weighted-average cohesion, filter out tiny clusters (<5 symbols).
   * Raw communities stay intact in LadybugDB for Cypher queries.
   */
  private aggregateClusters(clusters: any[]): any[] {
    const groups = new Map<string, { ids: string[]; totalSymbols: number; weightedCohesion: number; largest: any }>();

    for (const c of clusters) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      const symbols = c.symbolCount || 0;
      const cohesion = c.cohesion || 0;
      const existing = groups.get(label);

      if (!existing) {
        groups.set(label, { ids: [c.id], totalSymbols: symbols, weightedCohesion: cohesion * symbols, largest: c });
      } else {
        existing.ids.push(c.id);
        existing.totalSymbols += symbols;
        existing.weightedCohesion += cohesion * symbols;
        if (symbols > (existing.largest.symbolCount || 0)) {
          existing.largest = c;
        }
      }
    }

    return Array.from(groups.entries())
      .map(([label, g]) => ({
        id: g.largest.id,
        label,
        heuristicLabel: label,
        symbolCount: g.totalSymbols,
        cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
        subCommunities: g.ids.length,
      }))
      .filter(c => c.symbolCount >= 5)
      .sort((a, b) => b.symbolCount - a.symbolCount);
  }

  private async overview(repo: RepoHandle, params: { showClusters?: boolean; showProcesses?: boolean; limit?: number }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const limit = params.limit || 20;
    const result: any = {
      repo: repo.name,
      repoPath: repo.repoPath,
      stats: repo.stats,
      indexedAt: repo.indexedAt,
      lastCommit: repo.lastCommit,
    };
    
    if (params.showClusters !== false) {
      try {
        // Fetch more raw communities than the display limit so aggregation has enough data
        const rawLimit = Math.max(limit * 5, 200);
        const clusters = await executeQuery(repo.id, `
          MATCH (c:Community)
          RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
          ORDER BY c.symbolCount DESC
          LIMIT ${rawLimit}
        `);
        const rawClusters = clusters.map((c: any) => ({
          id: c.id || c[0],
          label: c.label || c[1],
          heuristicLabel: c.heuristicLabel || c[2],
          cohesion: c.cohesion || c[3],
          symbolCount: c.symbolCount || c[4],
        }));
        result.clusters = this.aggregateClusters(rawClusters).slice(0, limit);
      } catch {
        result.clusters = [];
      }
    }
    
    if (params.showProcesses !== false) {
      try {
        const processes = await executeQuery(repo.id, `
          MATCH (p:Process)
          RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
          ORDER BY p.stepCount DESC
          LIMIT ${limit}
        `);
        result.processes = processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        }));
      } catch {
        result.processes = [];
      }
    }
    
    return result;
  }

  /**
   * Context tool — 360-degree symbol view with categorized refs.
   * Disambiguation when multiple symbols share a name.
   * UID-based direct lookup. No cluster in output.
   */
  private async context(repo: RepoHandle, params: {
    name?: string;
    uid?: string;
    file_path?: string;
    include_content?: boolean;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const { name, uid, file_path, include_content } = params;
    
    if (!name && !uid) {
      return { error: 'Either "name" or "uid" parameter is required.' };
    }
    
    // Step 1: Find the symbol
    let symbols: any[];
    
    if (uid) {
      symbols = await executeParameterized(repo.id, `
        MATCH (n {id: $uid})
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
        LIMIT 1
      `, { uid });
    } else {
      const isQualified = name!.includes('/') || name!.includes(':');

      let whereClause: string;
      let queryParams: Record<string, any>;
      if (file_path) {
        whereClause = `WHERE n.name = $symName AND n.filePath CONTAINS $filePath`;
        queryParams = { symName: name!, filePath: file_path };
      } else if (isQualified) {
        whereClause = `WHERE n.id = $symName OR n.name = $symName`;
        queryParams = { symName: name! };
      } else {
        whereClause = `WHERE n.name = $symName`;
        queryParams = { symName: name! };
      }

      symbols = await executeParameterized(repo.id, `
        MATCH (n) ${whereClause}
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
        LIMIT 10
      `, queryParams);
    }
    
    if (symbols.length === 0) {
      return { error: `Symbol '${name || uid}' not found` };
    }
    
    // Step 2: Disambiguation
    if (symbols.length > 1 && !uid) {
      return {
        status: 'ambiguous',
        message: `Found ${symbols.length} symbols matching '${name}'. Use uid or file_path to disambiguate.`,
        candidates: symbols.map((s: any) => ({
          uid: s.id || s[0],
          name: s.name || s[1],
          kind: s.type || s[2],
          filePath: s.filePath || s[3],
          line: s.startLine || s[4],
        })),
      };
    }
    
    // Step 3: Class/Interface hint — redirect to methods
    const sym = symbols[0];
    const symId = sym.id || sym[0];
    const symKind = extractLabelFromQn(symId);

    if (symKind === 'Class' || symKind === 'Interface') {
      try {
        const methodRows = await executeParameterized(repo.id, `
          MATCH (n {id: $symId})-[r:CodeRelation {type: 'HAS_METHOD'}]->(m)
          RETURN m.name AS name, m.id AS uid, labels(m)[0] AS kind, m.startLine AS line
          ORDER BY m.startLine
          LIMIT 30
        `, { symId });
        if (methodRows.length > 0) {
          const methods = methodRows.map((r: any) => ({
            name: r.name || r[0],
            uid: r.uid || r[1],
            kind: r.kind || r[2],
            line: r.line || r[3],
          }));
          return {
            status: 'class_node',
            message: `${sym.name || sym[1]} is a ${symKind} — context/impact work best on functions/methods. Use one of its methods:`,
            file: sym.filePath || sym[3],
            methods,
          };
        }
      } catch (e) { logQueryError('context:class-methods', e); }
      // Fall through to normal context if no methods found
    }

    // Step 4: Build full context

    // Categorized incoming refs
    const incomingRows = await executeParameterized(repo.id, `
      MATCH (caller)-[r:CodeRelation]->(n {id: $symId})
      WHERE r.type IN ['CALLS', 'HTTP_CALLS', 'ASYNC_CALLS', 'EMITS', 'SUBSCRIBES_TO', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
      RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
      LIMIT 30
    `, { symId });

    // Categorized outgoing refs
    const outgoingRows = await executeParameterized(repo.id, `
      MATCH (n {id: $symId})-[r:CodeRelation]->(target)
      WHERE r.type IN ['CALLS', 'HTTP_CALLS', 'ASYNC_CALLS', 'EMITS', 'SUBSCRIBES_TO', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
      RETURN r.type AS relType, target.id AS uid, target.name AS name, target.filePath AS filePath, labels(target)[0] AS kind
      LIMIT 30
    `, { symId });

    // Process participation
    let processRows: any[] = [];
    try {
      processRows = await executeParameterized(repo.id, `
        MATCH (n {id: $symId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        RETURN p.id AS pid, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      `, { symId });
    } catch (e) { logQueryError('context:process-participation', e); }
    
    // Helper to categorize refs and group by file within each category
    const categorize = (rows: any[]) => {
      const cats: Record<string, any[]> = {};
      for (const row of rows) {
        const relType = (row.relType || row[0] || '').toLowerCase();
        const uid = row.uid || row[1];
        const entry = {
          uid,
          name: row.name || row[2],
          filePath: row.filePath || row[3],
          kind: extractLabelFromQn(uid),
        };
        if (!cats[relType]) cats[relType] = [];
        cats[relType].push(entry);
      }
      // Group each category's items by file
      for (const key of Object.keys(cats)) {
        cats[key] = groupByFile(cats[key]);
      }
      return cats;
    };
    
    return {
      status: 'found',
      symbol: {
        uid: sym.id || sym[0],
        name: sym.name || sym[1],
        kind: sym.type || sym[2],
        filePath: sym.filePath || sym[3],
        startLine: sym.startLine || sym[4],
        endLine: sym.endLine || sym[5],
        ...(include_content && (sym.content || sym[6]) ? { content: sym.content || sym[6] } : {}),
      },
      incoming: categorize(incomingRows),
      outgoing: categorize(outgoingRows),
      processes: processRows.map((r: any) => ({
        id: r.pid || r[0],
        name: r.label || r[1],
        step_index: r.step || r[2],
        step_count: r.stepCount || r[3],
      })),
    };
  }

  /**
   * Legacy explore — kept for backwards compatibility with resources.ts.
   * Routes cluster/process types to direct graph queries.
   */
  private async explore(repo: RepoHandle, params: { name: string; type: 'symbol' | 'cluster' | 'process' }): Promise<any> {
    await this.ensureInitialized(repo.id);
    const { name, type } = params;
    
    if (type === 'symbol') {
      return this.context(repo, { name });
    }
    
    if (type === 'cluster') {
      const clusters = await executeParameterized(repo.id, `
        MATCH (c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
      `, { clusterName: name });
      if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0], label: c.label || c[1], heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3], symbolCount: c.symbolCount || c[4],
      }));

      let totalSymbols = 0, weightedCohesion = 0;
      for (const c of rawClusters) {
        const s = c.symbolCount || 0;
        totalSymbols += s;
        weightedCohesion += (c.cohesion || 0) * s;
      }

      const members = await executeParameterized(repo.id, `
        MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
        LIMIT 30
      `, { clusterName: name });
      
      return {
        cluster: {
          id: rawClusters[0].id,
          label: rawClusters[0].heuristicLabel || rawClusters[0].label,
          heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
          cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
          symbolCount: totalSymbols,
          subCommunities: rawClusters.length,
        },
        members: members.map((m: any) => ({
          name: m.name || m[0], type: m.type || m[1], filePath: m.filePath || m[2],
        })),
      };
    }
    
    if (type === 'process') {
      const processes = await executeParameterized(repo.id, `
        MATCH (p:Process)
        WHERE p.label = $processName OR p.heuristicLabel = $processName
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        LIMIT 1
      `, { processName: name });
      if (processes.length === 0) return { error: `Process '${name}' not found` };

      const proc = processes[0];
      const procId = proc.id || proc[0];
      const steps = await executeParameterized(repo.id, `
        MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
        RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
        ORDER BY r.step
      `, { procId });
      
      return {
        process: {
          id: procId, label: proc.label || proc[1], heuristicLabel: proc.heuristicLabel || proc[2],
          processType: proc.processType || proc[3], stepCount: proc.stepCount || proc[4],
        },
        steps: steps.map((s: any) => ({
          step: s.step || s[3], name: s.name || s[0], type: s.type || s[1], filePath: s.filePath || s[2],
        })),
      };
    }
    
    return { error: 'Invalid type. Use: symbol, cluster, or process' };
  }

  /**
   * Detect changes — git-diff based impact analysis.
   * Maps changed lines to indexed symbols, then finds affected processes.
   */
  private async detectChanges(repo: RepoHandle, params: {
    scope?: string;
    base_ref?: string;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const scope = params.scope || 'unstaged';
    const { execFileSync } = await import('child_process');

    // Build git diff args based on scope (using execFileSync to avoid shell injection)
    let diffArgs: string[];
    switch (scope) {
      case 'staged':
        diffArgs = ['diff', '--staged', '--name-only'];
        break;
      case 'all':
        diffArgs = ['diff', 'HEAD', '--name-only'];
        break;
      case 'compare':
        if (!params.base_ref) return { error: 'base_ref is required for "compare" scope' };
        diffArgs = ['diff', params.base_ref, '--name-only'];
        break;
      case 'unstaged':
      default:
        diffArgs = ['diff', '--name-only'];
        break;
    }

    let changedFiles: string[];
    try {
      const output = execFileSync('git', diffArgs, { cwd: repo.repoPath, encoding: 'utf-8' });
      changedFiles = output.trim().split('\n').filter(f => f.length > 0);
    } catch (err: any) {
      return { error: `Git diff failed: ${err.message}` };
    }
    
    if (changedFiles.length === 0) {
      return {
        summary: { changed_count: 0, affected_count: 0, risk_level: 'none', message: 'No changes detected.' },
        changed_symbols: [],
        affected_processes: [],
      };
    }
    
    // Map changed files to indexed symbols
    const changedSymbols: any[] = [];
    for (const file of changedFiles) {
      const normalizedFile = file.replace(/\\/g, '/');
      try {
        const symbols = await executeParameterized(repo.id, `
          MATCH (n) WHERE n.filePath CONTAINS $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
          LIMIT 20
        `, { filePath: normalizedFile });
        for (const sym of symbols) {
          changedSymbols.push({
            id: sym.id || sym[0],
            name: sym.name || sym[1],
            type: sym.type || sym[2],
            filePath: sym.filePath || sym[3],
            change_type: 'Modified',
          });
        }
      } catch (e) { logQueryError('detect-changes:file-symbols', e); }
    }

    // Find affected processes
    const affectedProcesses = new Map<string, any>();
    for (const sym of changedSymbols) {
      try {
        const procs = await executeParameterized(repo.id, `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.heuristicLabel AS label, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `, { nodeId: sym.id });
        for (const proc of procs) {
          const pid = proc.pid || proc[0];
          if (!affectedProcesses.has(pid)) {
            affectedProcesses.set(pid, {
              id: pid,
              name: proc.label || proc[1],
              process_type: proc.processType || proc[2],
              step_count: proc.stepCount || proc[3],
              changed_steps: [],
            });
          }
          affectedProcesses.get(pid)!.changed_steps.push({
            symbol: sym.name,
            step: proc.step || proc[4],
          });
        }
      } catch (e) { logQueryError('detect-changes:process-lookup', e); }
    }

    const processCount = affectedProcesses.size;
    const risk = processCount === 0 ? 'low' : processCount <= 5 ? 'medium' : processCount <= 15 ? 'high' : 'critical';
    
    return {
      summary: {
        changed_count: changedSymbols.length,
        affected_count: processCount,
        changed_files: changedFiles.length,
        risk_level: risk,
      },
      changed_symbols: groupByFile(changedSymbols),
      affected_processes: Array.from(affectedProcesses.values()),
    };
  }

  /**
   * Rename tool — multi-file coordinated rename using graph + text search.
   * Graph refs are tagged "graph" (high confidence).
   * Additional refs found via text search are tagged "text_search" (lower confidence).
   */
  private async rename(repo: RepoHandle, params: {
    symbol_name?: string;
    symbol_uid?: string;
    new_name: string;
    file_path?: string;
    dry_run?: boolean;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const { new_name, file_path } = params;
    const dry_run = params.dry_run ?? true;

    if (!params.symbol_name && !params.symbol_uid) {
      return { error: 'Either symbol_name or symbol_uid is required.' };
    }

    /** Guard: ensure a file path resolves within the repo root (prevents path traversal) */
    const assertSafePath = (filePath: string): string => {
      const full = path.resolve(repo.repoPath, filePath);
      if (!full.startsWith(repo.repoPath + path.sep) && full !== repo.repoPath) {
        throw new Error(`Path traversal blocked: ${filePath}`);
      }
      return full;
    };
    
    // Step 1: Find the target symbol (reuse context's lookup)
    const lookupResult = await this.context(repo, {
      name: params.symbol_name,
      uid: params.symbol_uid,
      file_path,
    });
    
    if (lookupResult.status === 'ambiguous') {
      return lookupResult; // pass disambiguation through
    }
    if (lookupResult.error) {
      return lookupResult;
    }
    
    const sym = lookupResult.symbol;
    const oldName = sym.name;
    
    if (oldName === new_name) {
      return { error: 'New name is the same as the current name.' };
    }
    
    // Step 2: Collect edits from graph (high confidence)
    const changes = new Map<string, { file_path: string; edits: any[] }>();
    
    const addEdit = (filePath: string, line: number, oldText: string, newText: string, confidence: string) => {
      if (!changes.has(filePath)) {
        changes.set(filePath, { file_path: filePath, edits: [] });
      }
      changes.get(filePath)!.edits.push({ line, old_text: oldText, new_text: newText, confidence });
    };
    
    // The definition itself
    if (sym.filePath && sym.startLine) {
      try {
        const content = await fs.readFile(assertSafePath(sym.filePath), 'utf-8');
        const lines = content.split('\n');
        const lineIdx = sym.startLine - 1;
        if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].includes(oldName)) {
          const defRegex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          addEdit(sym.filePath, sym.startLine, lines[lineIdx].trim(), lines[lineIdx].replace(defRegex, new_name).trim(), 'graph');
        }
      } catch (e) { logQueryError('rename:read-definition', e); }
    }

    // All incoming refs from graph (callers, importers, etc.)
    const allIncoming = [
      ...(lookupResult.incoming.calls || []),
      ...(lookupResult.incoming.imports || []),
      ...(lookupResult.incoming.extends || []),
      ...(lookupResult.incoming.implements || []),
    ];
    
    let graphEdits = changes.size > 0 ? 1 : 0; // count definition edit
    
    for (const ref of allIncoming) {
      if (!ref.filePath) continue;
      try {
        const content = await fs.readFile(assertSafePath(ref.filePath), 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(oldName)) {
            addEdit(ref.filePath, i + 1, lines[i].trim(), lines[i].replace(new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), new_name).trim(), 'graph');
            graphEdits++;
            break; // one edit per file from graph refs
          }
        }
      } catch (e) { logQueryError('rename:read-ref', e); }
    }

    // Step 3: Text search for refs the graph might have missed
    let astSearchEdits = 0;
    const graphFiles = new Set([sym.filePath, ...allIncoming.map(r => r.filePath)].filter(Boolean));
    
    // Simple text search across the repo for the old name (in files not already covered by graph)
    try {
      const { execFileSync } = await import('child_process');
      const rgArgs = [
        '-l',
        '--type-add', 'code:*.{ts,tsx,js,jsx,py,go,rs,java,c,h,cpp,cc,cxx,hpp,hxx,hh,cs,php,swift}',
        '-t', 'code',
        `\\b${oldName}\\b`,
        '.',
      ];
      const output = execFileSync('rg', rgArgs, { cwd: repo.repoPath, encoding: 'utf-8', timeout: 5000 });
      const files = output.trim().split('\n').filter(f => f.length > 0);
      
      for (const file of files) {
        const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
        if (graphFiles.has(normalizedFile)) continue; // already covered by graph
        
        try {
          const content = await fs.readFile(assertSafePath(normalizedFile), 'utf-8');
          const lines = content.split('\n');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              regex.lastIndex = 0;
              addEdit(normalizedFile, i + 1, lines[i].trim(), lines[i].replace(regex, new_name).trim(), 'text_search');
              astSearchEdits++;
            }
          }
        } catch (e) { logQueryError('rename:text-search-read', e); }
      }
    } catch (e) { logQueryError('rename:ripgrep', e); }
    
    // Step 4: Apply or preview
    const allChanges = Array.from(changes.values());
    const totalEdits = allChanges.reduce((sum, c) => sum + c.edits.length, 0);
    
    if (!dry_run) {
      // Apply edits to files
      for (const change of allChanges) {
        try {
          const fullPath = assertSafePath(change.file_path);
          let content = await fs.readFile(fullPath, 'utf-8');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          content = content.replace(regex, new_name);
          await fs.writeFile(fullPath, content, 'utf-8');
        } catch (e) { logQueryError('rename:apply-edit', e); }
      }
    }
    
    return {
      status: 'success',
      old_name: oldName,
      new_name,
      files_affected: allChanges.length,
      total_edits: totalEdits,
      graph_edits: graphEdits,
      text_search_edits: astSearchEdits,
      changes: allChanges,
      applied: !dry_run,
    };
  }

  private async impact(repo: RepoHandle, params: {
    target: string;
    direction: 'upstream' | 'downstream';
    maxDepth?: number;
    relationTypes?: string[];
    includeTests?: boolean;
    minConfidence?: number;
    include_content?: boolean;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const { target, direction } = params;
    const maxDepth = params.maxDepth || 3;
    const rawRelTypes = params.relationTypes && params.relationTypes.length > 0
      ? params.relationTypes.filter(t => VALID_RELATION_TYPES.has(t))
      : ['CALLS', 'HTTP_CALLS', 'ASYNC_CALLS', 'EMITS', 'SUBSCRIBES_TO', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
    const relationTypes = rawRelTypes.length > 0 ? rawRelTypes : ['CALLS', 'HTTP_CALLS', 'ASYNC_CALLS', 'EMITS', 'SUBSCRIBES_TO', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
    const includeTests = params.includeTests ?? false;
    const minConfidence = params.minConfidence ?? 0;

    const relTypeFilter = relationTypes.map(t => `'${t}'`).join(', ');
    const confidenceFilter = minConfidence > 0 ? ` AND r.confidence >= ${minConfidence}` : '';

    const targets = await executeParameterized(repo.id, `
      MATCH (n)
      WHERE n.name = $targetName
      RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
      LIMIT 1
    `, { targetName: target });
    if (targets.length === 0) return { error: `Target '${target}' not found` };
    
    const sym = targets[0];
    const symId = sym.id || sym[0];
    const symKind = extractLabelFromQn(symId);

    // Class/Interface hint — redirect to methods for better results
    if (symKind === 'Class' || symKind === 'Interface') {
      try {
        const methodRows = await executeParameterized(repo.id, `
          MATCH (n {id: $symId})-[r:CodeRelation {type: 'HAS_METHOD'}]->(m)
          RETURN m.name AS name, m.id AS uid, labels(m)[0] AS kind, m.startLine AS line
          ORDER BY m.startLine
          LIMIT 30
        `, { symId });
        if (methodRows.length > 0) {
          return {
            status: 'class_node',
            message: `${sym.name || sym[1]} is a ${symKind} — impact analysis works best on functions/methods. Use one of its methods:`,
            file: sym.filePath || sym[3],
            methods: methodRows.map((r: any) => ({
              name: r.name || r[0],
              uid: r.uid || r[1],
              kind: r.kind || r[2],
              line: r.line || r[3],
            })),
          };
        }
      } catch (e) { logQueryError('impact:class-methods', e); }
    }

    const impacted: any[] = [];
    const visited = new Set<string>([symId]);
    let frontier = [symId];
    
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      
      // Batch frontier nodes into a single Cypher query per depth level
      const idList = frontier.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
      const query = direction === 'upstream'
        ? `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, labels(caller)[0] AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence`
        : `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, labels(callee)[0] AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence`;
      
      try {
        const related = await executeQuery(repo.id, query);
        
        for (const rel of related) {
          const relId = rel.id || rel[1];
          const filePath = rel.filePath || rel[4] || '';
          
          if (!includeTests && isTestFilePath(filePath)) continue;
          
          if (!visited.has(relId)) {
            visited.add(relId);
            nextFrontier.push(relId);
            impacted.push({
              depth,
              id: relId,
              name: rel.name || rel[2],
              type: rel.type || rel[3],
              filePath,
              relationType: rel.relType || rel[5],
              confidence: rel.confidence || rel[6] || 1.0,
            });
          }
        }
      } catch (e) { logQueryError('impact:depth-traversal', e); }
      
      frontier = nextFrontier;
    }
    
    const grouped: Record<number, any[]> = {};
    for (const item of impacted) {
      if (!grouped[item.depth]) grouped[item.depth] = [];
      grouped[item.depth].push(item);
    }

    // ── Enrichment: affected processes, modules, risk ──────────────
    const directCount = (grouped[1] || []).length;
    let affectedProcesses: any[] = [];
    let affectedModules: any[] = [];

    if (impacted.length > 0) {
      const allIds = impacted.map(i => `'${i.id.replace(/'/g, "''")}'`).join(', ');
      const d1Ids = (grouped[1] || []).map((i: any) => `'${i.id.replace(/'/g, "''")}'`).join(', ');

      // Affected processes: which execution flows are broken and at which step
      // NOTE: queries are run sequentially to avoid concurrent access to the
      // native DB addon (LadybugDB/KuzuDB C++ bindings are not thread-safe).
      // Running them via Promise.all caused non-deterministic segfaults (#292).
      const processRows = await executeQuery(repo.id, `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE s.id IN [${allIds}]
          RETURN p.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits, MIN(r.step) AS minStep, p.stepCount AS stepCount
          ORDER BY hits DESC
          LIMIT 20
        `).catch(() => []);
      const moduleRows = await executeQuery(repo.id, `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN [${allIds}]
          RETURN c.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits
          ORDER BY hits DESC
        `).catch(() => []);
      const directModuleRows = await (d1Ids ? executeQuery(repo.id, `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN [${d1Ids}]
          RETURN DISTINCT c.heuristicLabel AS name
        `).catch(() => []) : Promise.resolve([]));

      affectedProcesses = processRows.map((r: any) => ({
        name: r.name || r[0],
        hits: r.hits || r[1],
        broken_at_step: r.minStep ?? r[2],
        step_count: r.stepCount ?? r[3],
      }));

      const directModuleSet = new Set(directModuleRows.map((r: any) => r.name || r[0]));
      affectedModules = moduleRows.map((r: any) => {
        const name = r.name || r[0];
        return {
          name,
          hits: r.hits || r[1],
          impact: directModuleSet.has(name) ? 'direct' : 'indirect',
        };
      });
    }

    // Risk scoring — with explanation of what triggered the level
    const processCount = affectedProcesses.length;
    const moduleCount = affectedModules.length;
    let risk = 'LOW';
    const riskReasons: string[] = [];

    if (directCount >= 30) riskReasons.push(`${directCount} direct callers`);
    if (processCount >= 5) riskReasons.push(`${processCount} execution flows affected`);
    if (moduleCount >= 5) riskReasons.push(`${moduleCount} modules affected`);
    if (impacted.length >= 200) riskReasons.push(`${impacted.length} total impacted symbols`);

    if (directCount >= 30 || processCount >= 5 || moduleCount >= 5 || impacted.length >= 200) {
      risk = 'CRITICAL';
    } else if (directCount >= 15 || processCount >= 3 || moduleCount >= 3 || impacted.length >= 100) {
      risk = 'HIGH';
      if (directCount >= 15) riskReasons.push(`${directCount} direct callers`);
      if (processCount >= 3) riskReasons.push(`${processCount} execution flows affected`);
      if (impacted.length >= 100) riskReasons.push(`${impacted.length} total impacted`);
    } else if (directCount >= 5 || impacted.length >= 30) {
      risk = 'MEDIUM';
      if (directCount >= 5) riskReasons.push(`${directCount} direct callers`);
      if (impacted.length >= 30) riskReasons.push(`${impacted.length} total impacted`);
    }

    // Check if callers are concentrated in one module or spread across many
    const callerDirs = new Set<string>();
    for (const item of (grouped[1] || [])) {
      if (item.filePath) {
        const parts = item.filePath.split('/');
        callerDirs.add(parts.slice(0, Math.min(3, parts.length - 1)).join('/'));
      }
    }
    const callerSpread = callerDirs.size;

    // Optionally enrich depth-1 items with disk-fresh source (cap at depth 1 to avoid excessive I/O)
    if (params.include_content && grouped[1]) {
      for (const item of grouped[1]) {
        if (item.filePath && item.startLine != null && item.endLine != null) {
          try {
            const diskResult = await readSourceWithContext(repo.repoPath, item.filePath, item.startLine, item.endLine, 2);
            if (diskResult) {
              item.source = diskResult.source;
            } else if (item.content) {
              item.source = item.content;
            }
          } catch (e) { logQueryError('impact:disk-source', e); }
        }
      }
    }

    return {
      target: {
        id: symId,
        name: sym.name || sym[1],
        type: sym.type || sym[2],
        filePath: sym.filePath || sym[3],
      },
      direction,
      impactedCount: impacted.length,
      risk,
      risk_reasons: riskReasons.length > 0 ? riskReasons : ['few dependents'],
      caller_spread: callerSpread <= 1 ? 'concentrated (single module)' :
        callerSpread <= 3 ? `moderate (${callerSpread} directories)` :
        `wide (${callerSpread} directories)`,
      summary: {
        direct: directCount,
        processes_affected: processCount,
        modules_affected: moduleCount,
      },
      affected_processes: affectedProcesses,
      affected_modules: affectedModules,
      byDepth: Object.fromEntries(
        Object.entries(grouped).map(([depth, items]) => [depth, groupByFile(items as any[])])
      ),
    };
  }

  // ─── Direct Graph Queries (for resources.ts) ────────────────────

  /**
   * Query clusters (communities) directly from graph.
   * Used by getClustersResource — avoids legacy overview() dispatch.
   */
  async queryClusters(repoName?: string, limit = 100): Promise<{ clusters: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    try {
      const rawLimit = Math.max(limit * 5, 200);
      const clusters = await executeQuery(repo.id, `
        MATCH (c:Community)
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
        ORDER BY c.symbolCount DESC
        LIMIT ${rawLimit}
      `);
      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0],
        label: c.label || c[1],
        heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3],
        symbolCount: c.symbolCount || c[4],
      }));
      return { clusters: this.aggregateClusters(rawClusters).slice(0, limit) };
    } catch {
      return { clusters: [] };
    }
  }

  /**
   * Query processes directly from graph.
   * Used by getProcessesResource — avoids legacy overview() dispatch.
   */
  async queryProcesses(repoName?: string, limit = 50): Promise<{ processes: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    try {
      const processes = await executeQuery(repo.id, `
        MATCH (p:Process)
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        ORDER BY p.stepCount DESC
        LIMIT ${limit}
      `);
      return {
        processes: processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        })),
      };
    } catch {
      return { processes: [] };
    }
  }

  /**
   * Query cluster detail (members) directly from graph.
   * Used by getClusterDetailResource.
   */
  async queryClusterDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const clusters = await executeParameterized(repo.id, `
      MATCH (c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
    `, { clusterName: name });
    if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

    const rawClusters = clusters.map((c: any) => ({
      id: c.id || c[0], label: c.label || c[1], heuristicLabel: c.heuristicLabel || c[2],
      cohesion: c.cohesion || c[3], symbolCount: c.symbolCount || c[4],
    }));

    let totalSymbols = 0, weightedCohesion = 0;
    for (const c of rawClusters) {
      const s = c.symbolCount || 0;
      totalSymbols += s;
      weightedCohesion += (c.cohesion || 0) * s;
    }

    const members = await executeParameterized(repo.id, `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
      LIMIT 30
    `, { clusterName: name });

    return {
      cluster: {
        id: rawClusters[0].id,
        label: rawClusters[0].heuristicLabel || rawClusters[0].label,
        heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
        cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
        symbolCount: totalSymbols,
        subCommunities: rawClusters.length,
      },
      members: members.map((m: any) => ({
        name: m.name || m[0], type: m.type || m[1], filePath: m.filePath || m[2],
      })),
    };
  }

  /**
   * Query process detail (steps) directly from graph.
   * Used by getProcessDetailResource.
   */
  async queryProcessDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const processes = await executeParameterized(repo.id, `
      MATCH (p:Process)
      WHERE p.label = $processName OR p.heuristicLabel = $processName
      RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
      LIMIT 1
    `, { processName: name });
    if (processes.length === 0) return { error: `Process '${name}' not found` };

    const proc = processes[0];
    const procId = proc.id || proc[0];
    const steps = await executeParameterized(repo.id, `
      MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
      RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
      ORDER BY r.step
    `, { procId });

    return {
      process: {
        id: procId, label: proc.label || proc[1], heuristicLabel: proc.heuristicLabel || proc[2],
        processType: proc.processType || proc[3], stepCount: proc.stepCount || proc[4],
      },
      steps: steps.map((s: any) => ({
        step: s.step || s[3], name: s.name || s[0], type: s.type || s[1], filePath: s.filePath || s[2],
      })),
    };
  }

  async disconnect(): Promise<void> {
    await closeLbug(); // close all connections
    // Note: we intentionally do NOT call disposeEmbedder() here.
    // ONNX Runtime's native cleanup segfaults on macOS and some Linux configs,
    // and importing the embedder module on Node v24+ crashes if onnxruntime
    // was never loaded during the session. Since process.exit(0) follows
    // immediately after disconnect(), the OS reclaims everything. See #38, #89.
    this.repos.clear();
    this.contextCache.clear();
    this.initializedRepos.clear();
  }

  // ─── File Watcher Support ─────────────────────────────────────────

  /**
   * Return repo metadata needed for the file watcher (path + file count).
   * Used by startMCPServer() to configure adaptive polling intervals.
   */
  async getWatchableRepos(): Promise<Array<{ path: string; fileCount: number }>> {
    const entries = await listRegisteredRepos({ validate: true });
    return entries.map(e => ({
      path: e.path,
      fileCount: e.stats?.files ?? 0,
    }));
  }

  /**
   * Re-run the analysis pipeline for a repo and reload the KuzuDB connection.
   * Called by the file watcher when changes are detected.
   */
  async reindexRepo(repoPath: string): Promise<void> {
    const { runPipelineFromRepo } = await import('../../core/ingestion/pipeline.js');
    const { loadGraphToKuzu, closeKuzu } = await import('../../core/kuzu/kuzu-adapter.js');
    const { getStoragePaths, saveMeta, registerRepo } = await import('../../storage/repo-manager.js');
    const { getCurrentCommit } = await import('../../storage/git.js');

    const resolved = path.resolve(repoPath);
    const { storagePath } = getStoragePaths(resolved);

    // Close existing KuzuDB connection for this repo so we can reload
    const handle = [...this.repos.values()].find(h => h.repoPath === resolved);
    if (handle) {
      try { await closeKuzu(handle.id); } catch (err) {
        console.warn(`[reindexRepo] closeKuzu warning for ${resolved}: ${(err as Error).message}`);
      }
      this.initializedRepos.delete(handle.id);
    }

    // Re-run pipeline (no UI progress needed)
    const result = await runPipelineFromRepo(resolved, () => {});

    // Persist to KuzuDB
    await loadGraphToKuzu(result.graph, resolved, storagePath);

    // Update meta
    const meta = {
      repoPath: resolved,
      lastCommit: getCurrentCommit(resolved),
      indexedAt: new Date().toISOString(),
      stats: {
        files: result.totalFileCount,
        nodes: result.graph.nodeCount,
      },
    };
    await saveMeta(storagePath, meta);
    await registerRepo(resolved, meta);
  }

  // ─── search_graph ────────────────────────────────────────────────

  /**
   * Structured graph node search with degree/label/pattern filters.
   * Translates structured params into a single Cypher query with WHERE clauses.
   */
  private async searchGraph(repo: RepoHandle, params: {
    name_pattern?: string;
    label?: string;
    file_pattern?: string;
    min_degree?: number;
    max_degree?: number;
    direction?: 'inbound' | 'outbound' | 'both';
    sort_by?: 'degree' | 'name';
    limit?: number;
    offset?: number;
    exclude_labels?: string[];
    exclude_entry_points?: boolean;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const limit = Math.min(params.limit ?? 20, 100);
    const offset = params.offset ?? 0;
    const direction = params.direction ?? 'both';
    const sortBy = params.sort_by ?? 'degree';
    const excludeLabels = params.exclude_labels ?? ['Community', 'Process', 'Folder'];

    // Validate label if provided
    if (params.label && !VALID_NODE_LABELS.has(params.label)) {
      return { error: `Invalid label: ${params.label}. Valid labels: ${[...VALID_NODE_LABELS].join(', ')}` };
    }

    // Build MATCH clause — use specific label if provided, else generic node
    const matchClause = params.label ? `MATCH (n:\`${params.label}\`)` : 'MATCH (n)';

    // Build WHERE clauses
    const whereClauses: string[] = [];

    if (params.name_pattern) {
      whereClauses.push(`n.name =~ $namePattern`);
    }

    if (params.file_pattern) {
      whereClauses.push(`n.filePath CONTAINS $filePattern`);
    }

    if (!params.label && excludeLabels.length > 0) {
      // Exclude infrastructure labels when no specific label is requested
      const excluded = excludeLabels
        .filter(l => VALID_NODE_LABELS.has(l))
        .map(l => `'${l}'`)
        .join(', ');
      if (excluded) {
        whereClauses.push(`NOT labels(n)[0] IN [${excluded}]`);
      }
    }

    if (params.exclude_entry_points) {
      whereClauses.push(`(n.isEntryPoint IS NULL OR n.isEntryPoint = false)`);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Order clause
    const orderStr = sortBy === 'name' ? 'ORDER BY name' : 'ORDER BY total_degree DESC';

    const queryParams: Record<string, any> = {};
    if (params.name_pattern) queryParams.namePattern = params.name_pattern;
    if (params.file_pattern) queryParams.filePattern = params.file_pattern;

    // Degree filtering and sorting require a two-step approach in KuzuDB:
    // 1. Fetch candidate nodes that match filters
    // 2. Compute degrees per node via separate queries
    // For simplicity, fetch nodes first then compute degrees in JS.

    // Count query for total (without degree filtering — degree filter applied post-hoc)
    let total = 0;
    try {
      const countQuery = `${matchClause} ${whereStr} RETURN COUNT(n) AS cnt`;
      const countRows = await executeParameterized(repo.id, countQuery, queryParams);
      total = countRows[0]?.cnt ?? countRows[0]?.[0] ?? 0;
    } catch (e) { logQueryError('searchGraph:count', e); }

    // Data query — fetch more than needed to allow post-hoc degree filtering
    const fetchLimit = (params.min_degree !== undefined || params.max_degree !== undefined)
      ? Math.min(total, 500) : limit + offset;
    let results: any[] = [];
    try {
      const dataQuery = `
        ${matchClause} ${whereStr}
        RETURN n.id AS qn, n.name AS name, labels(n)[0] AS label,
               n.filePath AS file, n.startLine AS startLine, n.endLine AS endLine
        ${sortBy === 'name' ? 'ORDER BY n.name' : ''}
        LIMIT ${fetchLimit}
      `;
      const rows = await executeParameterized(repo.id, dataQuery, queryParams);
      const rawResults = await Promise.all(rows.map(async (r: any) => {
        const qn = r.qn ?? r[0] ?? '';
        const startLine = r.startLine ?? r[4];
        const endLine = r.endLine ?? r[5];
        const lines = (startLine != null && endLine != null)
          ? `${startLine}-${endLine}`
          : (startLine != null ? String(startLine) : '');

        // Compute degrees for this node
        let in_degree = 0, out_degree = 0;
        try {
          const degRows = await executeParameterized(repo.id,
            `MATCH (caller)-[:CodeRelation]->(n {id: $nid}) RETURN COUNT(caller) AS cnt`, { nid: qn });
          in_degree = degRows[0]?.cnt ?? degRows[0]?.[0] ?? 0;
        } catch {}
        try {
          const degRows = await executeParameterized(repo.id,
            `MATCH (n {id: $nid})-[:CodeRelation]->(callee) RETURN COUNT(callee) AS cnt`, { nid: qn });
          out_degree = degRows[0]?.cnt ?? degRows[0]?.[0] ?? 0;
        } catch {}

        const total_degree = direction === 'inbound' ? in_degree
          : direction === 'outbound' ? out_degree : in_degree + out_degree;

        if (params.min_degree !== undefined && total_degree < params.min_degree) return null;
        if (params.max_degree !== undefined && total_degree > params.max_degree) return null;

        return { name: r.name ?? r[1] ?? '', qn, label: extractLabelFromQn(qn),
          file: r.file ?? r[3] ?? '', lines, in_degree, out_degree, total_degree };
      }));

      let filtered = rawResults.filter(Boolean) as any[];
      if (sortBy === 'degree') filtered.sort((a, b) => b.total_degree - a.total_degree);
      total = filtered.length;
      results = filtered.slice(offset, offset + limit).map(({ total_degree, ...rest }) => rest);
    } catch (e) { logQueryError('searchGraph:data', e); }

    return {
      total,
      results,
      has_more: offset + results.length < total,
    };
  }

  // ─── quality_query ───────────────────────────────────────────────

  /**
   * Pre-built code quality and layer analysis queries.
   * Each preset is a focused Cypher query returning structured results.
   * Returns raw data — consumers apply their own thresholds and judgments.
   */
  private async qualityQuery(repo: RepoHandle, params: {
    preset: string;
    threshold?: number;
    function?: string;
    type?: string;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!isLbugReady(repo.id)) {
      return { error: 'LadybugDB not ready. Index may be corrupted.' };
    }

    const { preset, threshold, function: funcName, type: typeName } = params;

    try {
      const results = await this._runQualityPreset(repo, preset, { threshold, funcName, typeName });
      return { preset, results, count: results.length };
    } catch (err: any) {
      return { error: err.message || `quality_query preset '${preset}' failed` };
    }
  }

  private async _runQualityPreset(
    repo: RepoHandle,
    preset: string,
    opts: { threshold?: number; funcName?: string; typeName?: string },
  ): Promise<any[]> {
    const { threshold, funcName, typeName } = opts;

    switch (preset) {

      // ── high_complexity ────────────────────────────────────────────────
      // Functions/methods with cyclomatic complexity above threshold.
      case 'high_complexity': {
        if (threshold === undefined) throw new Error('threshold is required for high_complexity');
        const rows = await executeParameterized(repo.id, `
          MATCH (n)
          WHERE (labels(n)[0] IN ['Function', 'Method', 'Constructor'])
            AND n.complexity > $threshold
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS label,
                 n.filePath AS filePath, n.startLine AS startLine,
                 n.complexity AS complexity, n.sloc AS sloc
          ORDER BY n.complexity DESC
          LIMIT 200
        `, { threshold });
        return rows.map((r: any) => ({
          name: r.name ?? r[1],
          label: r.label ?? r[2],
          filePath: r.filePath ?? r[3],
          startLine: r.startLine ?? r[4],
          complexity: r.complexity ?? r[5],
          sloc: r.sloc ?? r[6],
        }));
      }

      // ── many_optionals ────────────────────────────────────────────────
      // Functions/methods that have more than threshold optional parameters.
      case 'many_optionals': {
        if (threshold === undefined) throw new Error('threshold is required for many_optionals');
        // Fetch all functions then count optional PARAM_OF edges in JS,
        // since KuzuDB's 200-row cap limits subquery aggregation reliability.
        const paramRows = await executeQuery(repo.id, `
          MATCH (p:Parameter)-[:CodeRelation {type: 'PARAM_OF'}]->(fn)
          WHERE p.isOptional = true
          RETURN fn.id AS fnId, fn.name AS fnName, labels(fn)[0] AS fnLabel,
                 fn.filePath AS filePath, fn.startLine AS startLine
        `);
        // Group by function
        const counts = new Map<string, { name: string; label: string; filePath: string; startLine: any; count: number }>();
        for (const r of paramRows) {
          const fnId = r.fnId ?? r[0] ?? '';
          if (!fnId) continue;
          if (!counts.has(fnId)) {
            counts.set(fnId, {
              name: r.fnName ?? r[1] ?? '',
              label: r.fnLabel ?? r[2] ?? '',
              filePath: r.filePath ?? r[3] ?? '',
              startLine: r.startLine ?? r[4],
              count: 0,
            });
          }
          counts.get(fnId)!.count += 1;
        }
        return [...counts.entries()]
          .filter(([, v]) => v.count > threshold)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([id, v]) => ({ id, ...v, optional_param_count: v.count }))
          .map(({ count, ...rest }) => rest);
      }

      // ── dead_code ─────────────────────────────────────────────────────
      // Functions/methods with zero inbound CALLS edges, excluding entry points
      // and test-file symbols.
      case 'dead_code': {
        const allFunctions = await executeQuery(repo.id, `
          MATCH (n)
          WHERE labels(n)[0] IN ['Function', 'Method', 'Constructor']
            AND (n.isEntryPoint IS NULL OR n.isEntryPoint = false)
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS label,
                 n.filePath AS filePath, n.startLine AS startLine
        `);
        const results: any[] = [];
        for (const r of allFunctions) {
          const id = r.id ?? r[0] ?? '';
          const filePath = r.filePath ?? r[3] ?? '';
          if (!id) continue;
          // Skip test files
          if (isTestFilePath(filePath)) continue;
          try {
            const callerRows = await executeParameterized(repo.id,
              `MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(n {id: $id}) RETURN COUNT(caller) AS cnt`,
              { id });
            const cnt = callerRows[0]?.cnt ?? callerRows[0]?.[0] ?? 0;
            if (cnt === 0) {
              results.push({
                name: r.name ?? r[1],
                label: r.label ?? r[2],
                filePath,
                startLine: r.startLine ?? r[4],
              });
            }
          } catch {}
        }
        return results;
      }

      // ── cross_class_field_access ──────────────────────────────────────
      // All READS_FIELD / WRITES_FIELD edges where the accessing function and the
      // accessed property belong to different classes.
      case 'cross_class_field_access': {
        const reads = await executeQuery(repo.id, `
          MATCH (src)-[:CodeRelation {type: 'READS_FIELD'}]->(prop)
          RETURN src.id AS srcId, src.name AS srcName, labels(src)[0] AS srcLabel,
                 src.filePath AS srcFile,
                 prop.id AS propId, prop.name AS propName, prop.visibility AS visibility,
                 'read' AS accessKind
          LIMIT 200
        `);
        const writes = await executeQuery(repo.id, `
          MATCH (src)-[:CodeRelation {type: 'WRITES_FIELD'}]->(prop)
          RETURN src.id AS srcId, src.name AS srcName, labels(src)[0] AS srcLabel,
                 src.filePath AS srcFile,
                 prop.id AS propId, prop.name AS propName, prop.visibility AS visibility,
                 'write' AS accessKind
          LIMIT 200
        `);
        const allRows = [...reads, ...writes];
        // Filter to cross-class accesses (exclude self-access where reason = 'self-access')
        return allRows.map((r: any) => ({
          accessor: r.srcName ?? r[1],
          accessorLabel: r.srcLabel ?? r[2],
          accessorFile: r.srcFile ?? r[3],
          field: r.propName ?? r[5],
          fieldVisibility: r.visibility ?? r[6],
          accessKind: r.accessKind ?? r[7],
        }));
      }

      // ── encapsulation_violations ──────────────────────────────────────
      // Cross-class READS_FIELD / WRITES_FIELD accesses to private or protected fields.
      case 'encapsulation_violations': {
        const reads = await executeQuery(repo.id, `
          MATCH (src)-[rel:CodeRelation {type: 'READS_FIELD'}]->(prop)
          WHERE prop.visibility IN ['private', 'protected']
            AND (rel.reason IS NULL OR rel.reason <> 'self-access')
          RETURN src.id AS srcId, src.name AS srcName, labels(src)[0] AS srcLabel,
                 src.filePath AS srcFile,
                 prop.id AS propId, prop.name AS propName, prop.visibility AS visibility,
                 'read' AS accessKind
          LIMIT 200
        `);
        const writes = await executeQuery(repo.id, `
          MATCH (src)-[rel:CodeRelation {type: 'WRITES_FIELD'}]->(prop)
          WHERE prop.visibility IN ['private', 'protected']
            AND (rel.reason IS NULL OR rel.reason <> 'self-access')
          RETURN src.id AS srcId, src.name AS srcName, labels(src)[0] AS srcLabel,
                 src.filePath AS srcFile,
                 prop.id AS propId, prop.name AS propName, prop.visibility AS visibility,
                 'write' AS accessKind
          LIMIT 200
        `);
        return [...reads, ...writes].map((r: any) => ({
          accessor: r.srcName ?? r[1],
          accessorLabel: r.srcLabel ?? r[2],
          accessorFile: r.srcFile ?? r[3],
          field: r.propName ?? r[5],
          fieldVisibility: r.visibility ?? r[6],
          accessKind: r.accessKind ?? r[7],
        }));
      }

      // ── unused_injections ────────────────────────────────────────────
      // Constructor parameters (with visibility = promoted fields) that are never
      // read via READS_FIELD from any sibling method of the same class.
      case 'unused_injections': {
        // Fetch all promoted constructor params (those with visibility set = TS constructor promotion)
        const paramRows = await executeQuery(repo.id, `
          MATCH (p:Parameter)-[:CodeRelation {type: 'PARAM_OF'}]->(ctor:Constructor)
          WHERE p.visibility IS NOT NULL
          RETURN p.id AS paramId, p.name AS paramName, p.visibility AS visibility,
                 ctor.id AS ctorId, ctor.filePath AS filePath
          LIMIT 500
        `);

        const results: any[] = [];
        for (const r of paramRows) {
          const paramName = r.paramName ?? r[1] ?? '';
          const ctorId = r.ctorId ?? r[3] ?? '';
          const filePath = r.filePath ?? r[4] ?? '';
          if (!paramName || !ctorId) continue;

          // Find the owning class of this constructor
          let classId = '';
          try {
            const classRows = await executeParameterized(repo.id,
              `MATCH (cls)-[:CodeRelation {type: 'HAS_METHOD'}]->(ctor {id: $ctorId}) RETURN cls.id AS id LIMIT 1`,
              { ctorId });
            classId = classRows[0]?.id ?? classRows[0]?.[0] ?? '';
          } catch {}
          if (!classId) continue;

          // Find all methods of this class (excluding the constructor)
          let methodIds: string[] = [];
          try {
            const methodRows = await executeParameterized(repo.id,
              `MATCH (cls {id: $classId})-[:CodeRelation {type: 'HAS_METHOD'}]->(m)
               WHERE labels(m)[0] = 'Method'
               RETURN m.id AS id`,
              { classId });
            methodIds = methodRows.map((mr: any) => mr.id ?? mr[0] ?? '').filter(Boolean);
          } catch {}
          if (methodIds.length === 0) {
            // No sibling methods — the param is trivially unused by methods
            results.push({ paramName, filePath, classId });
            continue;
          }

          // Check if any method has a READS_FIELD edge to the promoted property
          // The promoted property name matches the param name
          let used = false;
          for (const methodId of methodIds) {
            try {
              const readRows = await executeParameterized(repo.id,
                `MATCH (m {id: $methodId})-[:CodeRelation {type: 'READS_FIELD'}]->(prop)
                 WHERE prop.name = $propName
                 RETURN COUNT(prop) AS cnt`,
                { methodId, propName: paramName });
              const cnt = readRows[0]?.cnt ?? readRows[0]?.[0] ?? 0;
              if (cnt > 0) { used = true; break; }
            } catch {}
          }
          if (!used) {
            results.push({
              paramName,
              visibility: r.visibility ?? r[2],
              filePath,
              classId,
            });
          }
        }
        return results;
      }

      // ── overused_injections ──────────────────────────────────────────
      // Constructor params referenced by more than 80% of the class's methods.
      case 'overused_injections': {
        const paramRows = await executeQuery(repo.id, `
          MATCH (p:Parameter)-[:CodeRelation {type: 'PARAM_OF'}]->(ctor:Constructor)
          WHERE p.visibility IS NOT NULL
          RETURN p.id AS paramId, p.name AS paramName, p.visibility AS visibility,
                 ctor.id AS ctorId, ctor.filePath AS filePath
          LIMIT 500
        `);

        const results: any[] = [];
        for (const r of paramRows) {
          const paramName = r.paramName ?? r[1] ?? '';
          const ctorId = r.ctorId ?? r[3] ?? '';
          const filePath = r.filePath ?? r[4] ?? '';
          if (!paramName || !ctorId) continue;

          let classId = '';
          try {
            const classRows = await executeParameterized(repo.id,
              `MATCH (cls)-[:CodeRelation {type: 'HAS_METHOD'}]->(ctor {id: $ctorId}) RETURN cls.id AS id LIMIT 1`,
              { ctorId });
            classId = classRows[0]?.id ?? classRows[0]?.[0] ?? '';
          } catch {}
          if (!classId) continue;

          let methodIds: string[] = [];
          try {
            const methodRows = await executeParameterized(repo.id,
              `MATCH (cls {id: $classId})-[:CodeRelation {type: 'HAS_METHOD'}]->(m)
               WHERE labels(m)[0] = 'Method'
               RETURN m.id AS id`,
              { classId });
            methodIds = methodRows.map((mr: any) => mr.id ?? mr[0] ?? '').filter(Boolean);
          } catch {}
          if (methodIds.length === 0) continue;

          let usageCount = 0;
          for (const methodId of methodIds) {
            try {
              const readRows = await executeParameterized(repo.id,
                `MATCH (m {id: $methodId})-[:CodeRelation {type: 'READS_FIELD'}]->(prop)
                 WHERE prop.name = $propName
                 RETURN COUNT(prop) AS cnt`,
                { methodId, propName: paramName });
              const cnt = readRows[0]?.cnt ?? readRows[0]?.[0] ?? 0;
              if (cnt > 0) usageCount += 1;
            } catch {}
          }

          const usageRatio = usageCount / methodIds.length;
          if (usageRatio > 0.8) {
            results.push({
              paramName,
              visibility: r.visibility ?? r[2],
              filePath,
              classId,
              usedByMethodCount: usageCount,
              totalMethodCount: methodIds.length,
              usageRatio: Math.round(usageRatio * 100) / 100,
            });
          }
        }
        return results;
      }

      // ── params_by_type ────────────────────────────────────────────────
      // All Parameter nodes that have a USES_TYPE edge to the given type.
      case 'params_by_type': {
        if (!typeName) throw new Error('type is required for params_by_type');
        const rows = await executeParameterized(repo.id, `
          MATCH (p:Parameter)-[:CodeRelation {type: 'USES_TYPE'}]->(t)
          WHERE t.name = $typeName
          RETURN p.id AS paramId, p.name AS paramName, p.ordinal AS ordinal,
                 p.isOptional AS isOptional, p.isRest AS isRest,
                 t.name AS typeName, p.filePath AS filePath
          ORDER BY p.filePath
          LIMIT 200
        `, { typeName });
        return rows.map((r: any) => ({
          paramName: r.paramName ?? r[1],
          ordinal: r.ordinal ?? r[2],
          isOptional: r.isOptional ?? r[3],
          isRest: r.isRest ?? r[4],
          typeName: r.typeName ?? r[5],
          filePath: r.filePath ?? r[6],
        }));
      }

      // ── param_fan_in ──────────────────────────────────────────────────
      // Types ranked by how many Parameter nodes reference them via USES_TYPE.
      case 'param_fan_in': {
        const rows = await executeQuery(repo.id, `
          MATCH (p:Parameter)-[:CodeRelation {type: 'USES_TYPE'}]->(t)
          RETURN t.name AS typeName, t.id AS typeId, labels(t)[0] AS typeLabel,
                 COUNT(p) AS paramCount
          ORDER BY paramCount DESC
          LIMIT 100
        `);
        return rows.map((r: any) => ({
          typeName: r.typeName ?? r[0],
          typeLabel: r.typeLabel ?? r[2],
          paramCount: r.paramCount ?? r[3],
        }));
      }

      // ── type_coupling ─────────────────────────────────────────────────
      // Classes and interfaces ranked by inbound USES_TYPE count (from all sources,
      // not just Parameters).
      case 'type_coupling': {
        const rows = await executeQuery(repo.id, `
          MATCH (src)-[:CodeRelation {type: 'USES_TYPE'}]->(t)
          RETURN t.name AS typeName, t.id AS typeId, labels(t)[0] AS typeLabel,
                 t.filePath AS filePath, COUNT(src) AS usageCount
          ORDER BY usageCount DESC
          LIMIT 100
        `);
        return rows.map((r: any) => ({
          typeName: r.typeName ?? r[0],
          typeLabel: r.typeLabel ?? r[2],
          filePath: r.filePath ?? r[3],
          usageCount: r.usageCount ?? r[4],
        }));
      }

      // ── layer_violations ─────────────────────────────────────────────
      // Calls from "leaf" nodes (low fan-in, many callees = worker/utility functions)
      // to "entry" nodes (high fan-in = shared hubs or services that should only be
      // called by orchestrators, not by leaves).
      // Heuristic: entry node = in_degree >= 10; leaf node = in_degree <= 1, out_degree >= 3.
      case 'layer_violations': {
        // Step 1: identify entry nodes (high fan-in) and leaf nodes (low fan-in, high fan-out)
        // For performance, we do this in two passes.
        const funcRows = await executeQuery(repo.id, `
          MATCH (n)
          WHERE labels(n)[0] IN ['Function', 'Method']
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath
          LIMIT 1000
        `);

        // Compute degrees in batch
        const nodeData: Array<{ id: string; name: string; filePath: string; inDeg: number; outDeg: number }> = [];
        for (const r of funcRows) {
          const id = r.id ?? r[0] ?? '';
          if (!id) continue;
          let inDeg = 0, outDeg = 0;
          try {
            const iRows = await executeParameterized(repo.id,
              `MATCH (c)-[:CodeRelation {type: 'CALLS'}]->(n {id: $id}) RETURN COUNT(c) AS cnt`, { id });
            inDeg = iRows[0]?.cnt ?? iRows[0]?.[0] ?? 0;
          } catch {}
          try {
            const oRows = await executeParameterized(repo.id,
              `MATCH (n {id: $id})-[:CodeRelation {type: 'CALLS'}]->(c) RETURN COUNT(c) AS cnt`, { id });
            outDeg = oRows[0]?.cnt ?? oRows[0]?.[0] ?? 0;
          } catch {}
          nodeData.push({ id, name: r.name ?? r[1] ?? '', filePath: r.filePath ?? r[2] ?? '', inDeg, outDeg });
        }

        const entryIds = new Set(nodeData.filter(n => n.inDeg >= 10).map(n => n.id));
        const leafIds = new Set(nodeData.filter(n => n.inDeg <= 1 && n.outDeg >= 3).map(n => n.id));

        if (leafIds.size === 0 || entryIds.size === 0) return [];

        // Step 2: find CALLS edges from leaf → entry
        const violations: any[] = [];
        for (const leafId of leafIds) {
          try {
            const callRows = await executeParameterized(repo.id,
              `MATCH (leaf {id: $leafId})-[:CodeRelation {type: 'CALLS'}]->(target)
               RETURN target.id AS targetId, target.name AS targetName, target.filePath AS targetFile`,
              { leafId });
            for (const cr of callRows) {
              const targetId = cr.targetId ?? cr[0] ?? '';
              if (entryIds.has(targetId)) {
                const leaf = nodeData.find(n => n.id === leafId)!;
                violations.push({
                  caller: leaf.name,
                  callerFile: leaf.filePath,
                  callerInDegree: leaf.inDeg,
                  callee: cr.targetName ?? cr[1],
                  calleeFile: cr.targetFile ?? cr[2],
                  calleeInDegree: nodeData.find(n => n.id === targetId)?.inDeg ?? 0,
                });
              }
            }
          } catch {}
        }
        return violations;
      }

      // ── god_functions ─────────────────────────────────────────────────
      // Functions with high complexity AND high fan-out AND many params.
      // Thresholds: complexity > 10, outbound CALLS > 8, parameterCount > 4.
      case 'god_functions': {
        const complexityThreshold = threshold ?? 10;
        const rows = await executeParameterized(repo.id, `
          MATCH (n)
          WHERE labels(n)[0] IN ['Function', 'Method']
            AND n.complexity > $complexity
            AND n.parameterCount > 4
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS label,
                 n.filePath AS filePath, n.startLine AS startLine,
                 n.complexity AS complexity, n.parameterCount AS parameterCount
          ORDER BY n.complexity DESC
          LIMIT 200
        `, { complexity: complexityThreshold });

        const results: any[] = [];
        for (const r of rows) {
          const id = r.id ?? r[0] ?? '';
          if (!id) continue;
          let outDeg = 0;
          try {
            const degRows = await executeParameterized(repo.id,
              `MATCH (n {id: $id})-[:CodeRelation {type: 'CALLS'}]->(c) RETURN COUNT(c) AS cnt`, { id });
            outDeg = degRows[0]?.cnt ?? degRows[0]?.[0] ?? 0;
          } catch {}
          if (outDeg > 8) {
            results.push({
              name: r.name ?? r[1],
              label: r.label ?? r[2],
              filePath: r.filePath ?? r[3],
              startLine: r.startLine ?? r[4],
              complexity: r.complexity ?? r[5],
              parameterCount: r.parameterCount ?? r[6],
              outboundCalls: outDeg,
            });
          }
        }
        return results.sort((a, b) => b.complexity - a.complexity);
      }

      // ── throw_diversity ───────────────────────────────────────────────
      // Functions that throw more than threshold distinct exception types.
      case 'throw_diversity': {
        if (threshold === undefined) throw new Error('threshold is required for throw_diversity');
        const rows = await executeQuery(repo.id, `
          MATCH (fn)-[:CodeRelation {type: 'THROWS'}]->(exc)
          RETURN fn.id AS fnId, fn.name AS fnName, fn.filePath AS filePath,
                 exc.name AS exceptionName
          LIMIT 1000
        `);
        // Group by function
        const fnExceptions = new Map<string, { name: string; filePath: string; exceptions: Set<string> }>();
        for (const r of rows) {
          const fnId = r.fnId ?? r[0] ?? '';
          if (!fnId) continue;
          if (!fnExceptions.has(fnId)) {
            fnExceptions.set(fnId, {
              name: r.fnName ?? r[1] ?? '',
              filePath: r.filePath ?? r[2] ?? '',
              exceptions: new Set(),
            });
          }
          const excName = r.exceptionName ?? r[3];
          if (excName) fnExceptions.get(fnId)!.exceptions.add(excName);
        }
        return [...fnExceptions.entries()]
          .filter(([, v]) => v.exceptions.size > threshold)
          .sort((a, b) => b[1].exceptions.size - a[1].exceptions.size)
          .map(([, v]) => ({
            name: v.name,
            filePath: v.filePath,
            exceptionCount: v.exceptions.size,
            exceptions: [...v.exceptions],
          }));
      }

      // ── accessor_vs_direct ────────────────────────────────────────────
      // READS_FIELD edges to a property where an accessor (getter) also exists
      // for the same property — i.e., the read bypasses the getter.
      case 'accessor_vs_direct': {
        const rows = await executeQuery(repo.id, `
          MATCH (src)-[rel:CodeRelation {type: 'READS_FIELD'}]->(prop)
          RETURN src.id AS srcId, src.name AS srcName, labels(src)[0] AS srcLabel,
                 src.filePath AS srcFile,
                 prop.id AS propId, prop.name AS propName, prop.visibility AS visibility
          LIMIT 500
        `);

        const violations: any[] = [];
        for (const r of rows) {
          const propId = r.propId ?? r[4] ?? '';
          const propName = r.propName ?? r[5] ?? '';
          if (!propId || !propName) continue;

          // Check if a getter accessor exists for the same name in the same class
          try {
            const accessorRows = await executeParameterized(repo.id,
              `MATCH (cls)-[:CodeRelation {type: 'HAS_METHOD'}]->(m)
               WHERE m.name = $propName AND m.isAccessor = true
               RETURN m.id AS id LIMIT 1`,
              { propName });
            if (accessorRows.length > 0) {
              violations.push({
                accessor: r.srcName ?? r[1],
                accessorLabel: r.srcLabel ?? r[2],
                accessorFile: r.srcFile ?? r[3],
                field: propName,
                fieldVisibility: r.visibility ?? r[6],
                bypassesGetter: true,
              });
            }
          } catch {}
        }
        return violations;
      }

      // ── conditional_calls ─────────────────────────────────────────────
      // All CALLS edges from a given function, annotated with conditionality metadata.
      case 'conditional_calls': {
        if (!funcName) throw new Error('function is required for conditional_calls');
        const rows = await executeParameterized(repo.id, `
          MATCH (src)-[rel:CodeRelation {type: 'CALLS'}]->(target)
          WHERE src.name = $funcName
          RETURN target.name AS callee, target.filePath AS calleeFile,
                 rel.isConditional AS isConditional,
                 rel.guardExpression AS guardExpression,
                 rel.branchDepth AS branchDepth
          ORDER BY rel.branchDepth
        `, { funcName });
        return rows.map((r: any) => ({
          callee: r.callee ?? r[0],
          calleeFile: r.calleeFile ?? r[1],
          isConditional: r.isConditional ?? r[2] ?? false,
          guardExpression: r.guardExpression ?? r[3] ?? null,
          branchDepth: r.branchDepth ?? r[4] ?? 0,
        }));
      }

      // ── hot_path ──────────────────────────────────────────────────────
      // BFS from a given function following only unconditional CALLS edges
      // (isConditional = false or absent). Returns the always-executed call chain.
      case 'hot_path': {
        if (!funcName) throw new Error('function is required for hot_path');
        // Find the source function node
        const srcRows = await executeParameterized(repo.id,
          `MATCH (n) WHERE n.name = $funcName RETURN n.id AS id, n.filePath AS filePath LIMIT 1`,
          { funcName });
        if (srcRows.length === 0) return [];

        const startId = srcRows[0].id ?? srcRows[0][0];
        const visited = new Set<string>([startId]);
        const chain: Array<{ depth: number; name: string; filePath: string; id: string }> = [];
        let frontier = [startId];
        let depth = 0;
        const MAX_DEPTH = 20;

        while (frontier.length > 0 && depth < MAX_DEPTH) {
          const nextFrontier: string[] = [];
          for (const nodeId of frontier) {
            try {
              const edgeRows = await executeParameterized(repo.id,
                `MATCH (n {id: $nodeId})-[rel:CodeRelation {type: 'CALLS'}]->(target)
                 WHERE rel.isConditional IS NULL OR rel.isConditional = false
                 RETURN target.id AS targetId, target.name AS targetName, target.filePath AS targetFile`,
                { nodeId });
              for (const er of edgeRows) {
                const targetId = er.targetId ?? er[0] ?? '';
                if (!targetId || visited.has(targetId)) continue;
                visited.add(targetId);
                chain.push({
                  depth: depth + 1,
                  name: er.targetName ?? er[1] ?? '',
                  filePath: er.targetFile ?? er[2] ?? '',
                  id: targetId,
                });
                nextFrontier.push(targetId);
              }
            } catch {}
          }
          frontier = nextFrontier;
          depth++;
        }
        return chain;
      }

      // ── guarded_paths ─────────────────────────────────────────────────
      // BFS from a given function following only conditional CALLS edges.
      // Groups results by guardExpression.
      case 'guarded_paths': {
        if (!funcName) throw new Error('function is required for guarded_paths');
        const srcRows = await executeParameterized(repo.id,
          `MATCH (n) WHERE n.name = $funcName RETURN n.id AS id LIMIT 1`,
          { funcName });
        if (srcRows.length === 0) return [];

        const startId = srcRows[0].id ?? srcRows[0][0];
        const visited = new Set<string>([startId]);
        const guardGroups = new Map<string, { guard: string; branchDepth: number; calls: Array<{ name: string; filePath: string }> }>();
        let frontier = [startId];
        let depth = 0;
        const MAX_DEPTH = 20;

        while (frontier.length > 0 && depth < MAX_DEPTH) {
          const nextFrontier: string[] = [];
          for (const nodeId of frontier) {
            try {
              const edgeRows = await executeParameterized(repo.id,
                `MATCH (n {id: $nodeId})-[rel:CodeRelation {type: 'CALLS'}]->(target)
                 WHERE rel.isConditional = true
                 RETURN target.id AS targetId, target.name AS targetName, target.filePath AS targetFile,
                        rel.guardExpression AS guardExpression, rel.branchDepth AS branchDepth`,
                { nodeId });
              for (const er of edgeRows) {
                const targetId = er.targetId ?? er[0] ?? '';
                if (!targetId || visited.has(targetId)) continue;
                visited.add(targetId);
                nextFrontier.push(targetId);
                const guard = er.guardExpression ?? er[3] ?? 'unknown';
                if (!guardGroups.has(guard)) {
                  guardGroups.set(guard, { guard, branchDepth: er.branchDepth ?? er[4] ?? 1, calls: [] });
                }
                guardGroups.get(guard)!.calls.push({
                  name: er.targetName ?? er[1] ?? '',
                  filePath: er.targetFile ?? er[2] ?? '',
                });
              }
            } catch {}
          }
          frontier = nextFrontier;
          depth++;
        }
        return [...guardGroups.values()].sort((a, b) => a.branchDepth - b.branchDepth);
      }

      default:
        throw new Error(`Unknown quality_query preset: ${preset}. Valid presets: high_complexity, many_optionals, dead_code, cross_class_field_access, encapsulation_violations, unused_injections, overused_injections, params_by_type, param_fan_in, type_coupling, layer_violations, god_functions, throw_diversity, accessor_vs_direct, conditional_calls, hot_path, guarded_paths`);
    }
  }

  // ─── get_architecture ────────────────────────────────────────────

  /**
   * Multi-aspect architecture view via aspect-specific Cypher queries.
   */
  private async getArchitecture(repo: RepoHandle, params: {
    aspects?: string[];
  }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const requested = params.aspects ?? ['all'];
    const all = requested.includes('all');
    const wants = (aspect: string) => all || requested.includes(aspect);

    const result: Record<string, any> = {};

    if (wants('languages')) {
      try {
        // Language derived from file extensions (language property not stored in KuzuDB)
        const rows = await executeQuery(repo.id, `MATCH (f:File) RETURN f.filePath AS fp`);
        const extCounts = new Map<string, number>();
        const extToLang: Record<string, string> = {
          '.ts': 'TypeScript', '.tsx': 'TypeScript (TSX)', '.js': 'JavaScript', '.jsx': 'JavaScript (JSX)',
          '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
          '.c': 'C', '.cpp': 'C++', '.h': 'C/C++ Header', '.cs': 'C#', '.rb': 'Ruby',
          '.php': 'PHP', '.swift': 'Swift', '.vue': 'Vue', '.svelte': 'Svelte',
        };
        for (const r of rows) {
          const fp = (r.fp ?? r[0]) as string;
          const dot = fp.lastIndexOf('.');
          if (dot < 0) continue;
          const ext = fp.slice(dot).toLowerCase();
          const lang = extToLang[ext];
          if (lang) extCounts.set(lang, (extCounts.get(lang) ?? 0) + 1);
        }
        result.languages = [...extCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([language, file_count]) => ({ language, file_count }));
      } catch (e) {
        logQueryError('getArchitecture:languages', e);
        result.languages = [];
      }
    }

    if (wants('packages')) {
      try {
        const rows = await executeQuery(repo.id, `
          MATCH (f:File)
          WHERE f.filePath IS NOT NULL
          WITH split(f.filePath, '/')[0] AS topDir, COUNT(f) AS fileCount
          WHERE topDir <> '' AND topDir IS NOT NULL
          RETURN topDir AS name, fileCount
          ORDER BY fileCount DESC
          LIMIT 30
        `);
        result.packages = rows.map((r: any) => ({
          name: r.name ?? r[0],
          file_count: r.fileCount ?? r[1],
        }));
      } catch (e) {
        logQueryError('getArchitecture:packages', e);
        result.packages = [];
      }
    }

    if (wants('entry_points')) {
      try {
        // Real entry points: functions/classes in index/main files, CLI commands, route handlers
        // Not just "all exported symbols" — that's the public API, not entry points
        const rows = await executeQuery(repo.id, `
          MATCH (n) WHERE n.isExported = true
          AND NOT labels(n)[0] IN ['File', 'Folder', 'Community', 'Process', 'Const']
          AND (
            n.filePath ENDS WITH '/index.ts'
            OR n.filePath ENDS WITH '/main.ts'
            OR n.filePath ENDS WITH '/index.js'
            OR n.filePath ENDS WITH '/main.js'
            OR n.filePath CONTAINS '/cli/'
            OR n.filePath CONTAINS '/commands/'
            OR n.filePath CONTAINS '/routes/'
            OR n.filePath CONTAINS '/handlers/'
            OR n.filePath CONTAINS '/pages/'
            OR n.filePath CONTAINS '/views/'
          )
          RETURN n.id AS qn, n.name AS name, n.filePath AS filePath
          LIMIT 30
        `);
        result.entry_points = groupByFile(rows.map((r: any) => ({
          name: r.name ?? r[1],
          label: extractLabelFromQn(r.qn ?? r[0]),
          filePath: r.filePath ?? r[2],
        })));
      } catch (e) {
        logQueryError('getArchitecture:entry_points', e);
        result.entry_points = [];
      }
    }

    if (wants('routes')) {
      try {
        const rows = await executeQuery(repo.id, `
          MATCH (n:Route)
          RETURN n.name AS name, n.filePath AS filePath
          LIMIT 30
        `);
        result.routes = groupByFile(rows.map((r: any) => ({
          name: r.name ?? r[0],
          filePath: r.filePath ?? r[1],
        })));
      } catch (e) {
        logQueryError('getArchitecture:routes', e);
        result.routes = [];
      }
    }

    if (wants('hotspots')) {
      try {
        // Count inbound CALLS per target, fetch top 40 (we'll split infra vs app)
        const rows = await executeQuery(repo.id, `
          MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(n)
          RETURN n.id AS qn, n.name AS name,
                 n.filePath AS filePath, n.startLine AS startLine,
                 COUNT(caller) AS caller_count
          ORDER BY caller_count DESC
          LIMIT 40
        `);

        // Classify: infrastructure = called from 5+ distinct directories (shared utility)
        // Application = callers concentrated in fewer directories (domain coupling)
        const infra: any[] = [];
        const app: any[] = [];
        for (const r of rows) {
          const qn = r.qn ?? r[0];
          const name = r.name ?? r[1];
          const file = r.filePath ?? r[2];
          const callerCount = r.caller_count ?? r[3];
          const label = extractLabelFromQn(qn);
          const entry = { name, label, file, caller_count: callerCount };

          // Heuristic: functions in utility/core/shared paths, or with very generic names
          const isInfraPath = file && (
            file.includes('/core/') || file.includes('/utils/') || file.includes('/utilities/') ||
            file.includes('/helpers/') || file.includes('/lib/') || file.includes('/shared/') ||
            file.includes('event-bus') || file.includes('logger') || file.includes('log-')
          );

          if (isInfraPath) {
            infra.push(entry);
          } else {
            app.push(entry);
          }
        }

        result.hotspots = {
          application: app.slice(0, 15),
          infrastructure: infra.slice(0, 10),
        };
      } catch (e) {
        logQueryError('getArchitecture:hotspots', e);
        result.hotspots = { application: [], infrastructure: [] };
      }
    }

    if (wants('boundaries')) {
      try {
        // Directory-based module boundaries — uses file path segments, NOT cluster labels.
        // Extracts the module directory (2nd or 3rd path segment) as the boundary unit.
        const rows = await executeQuery(repo.id, `
          MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b)
          WHERE a.filePath IS NOT NULL AND b.filePath IS NOT NULL
            AND a.filePath <> b.filePath
          RETURN a.filePath AS from_file, b.filePath AS to_file
        `);

        // Derive module from file path: use first 2 significant segments
        // e.g. "src/game/features/logistics/dispatcher.ts" → "game/features/logistics"
        // e.g. "src/components/use-renderer/index.ts" → "components/use-renderer"
        const deriveModule = (fp: string): string => {
          const parts = fp.split('/');
          // Skip common prefixes like 'src', 'lib', 'app'
          const start = (parts[0] === 'src' || parts[0] === 'lib' || parts[0] === 'app') ? 1 : 0;
          // Take up to 3 segments after prefix for granularity
          const significant = parts.slice(start, start + 3);
          // Drop the filename (last segment if it has an extension)
          if (significant.length > 1 && significant[significant.length - 1].includes('.')) {
            significant.pop();
          }
          return significant.join('/') || parts[0];
        };

        const pairCounts = new Map<string, number>();
        for (const row of rows) {
          const fromFile = (row.from_file ?? row[0]) as string;
          const toFile = (row.to_file ?? row[1]) as string;
          const fromMod = deriveModule(fromFile);
          const toMod = deriveModule(toFile);
          if (fromMod === toMod) continue; // skip intra-module
          const key = `${fromMod}\0${toMod}`;
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }

        // Filter out test→test and test→source dependencies (noise for architecture analysis)
        const isTestModule = (mod: string) =>
          mod.startsWith('tests/') || mod.startsWith('test/') || mod.startsWith('__tests__/') || mod.includes('/test/');

        result.boundaries = [...pairCounts.entries()]
          .map(([key, count]) => {
            const [from, to] = key.split('\0');
            return { from_module: from, to_module: to, call_count: count };
          })
          .filter(b => !isTestModule(b.from_module)) // exclude test→anything
          .sort((a, b) => b.call_count - a.call_count)
          .slice(0, 30);
      } catch (e) {
        logQueryError('getArchitecture:boundaries', e);
        result.boundaries = [];
      }
    }

    if (wants('services')) {
      try {
        // Cross-service HTTP/async calls — directory-based module boundaries
        const rows = await executeQuery(repo.id, `
          MATCH (a)-[r:CodeRelation]->(b)
          WHERE r.type IN ['HTTP_CALLS', 'ASYNC_CALLS']
            AND a.filePath IS NOT NULL AND b.filePath IS NOT NULL
          RETURN a.filePath AS from_file, b.filePath AS to_file,
                 r.type AS call_type
        `);

        const deriveModule = (fp: string): string => {
          const parts = fp.split('/');
          const start = (parts[0] === 'src' || parts[0] === 'lib' || parts[0] === 'app') ? 1 : 0;
          const significant = parts.slice(start, start + 3);
          if (significant.length > 1 && significant[significant.length - 1].includes('.')) {
            significant.pop();
          }
          return significant.join('/') || parts[0];
        };

        const pairCounts = new Map<string, { callType: string; count: number }>();
        for (const row of rows) {
          const fromMod = deriveModule((row.from_file ?? row[0]) as string);
          const toMod = deriveModule((row.to_file ?? row[1]) as string);
          const callType = (row.call_type ?? row[2]) as string;
          const key = `${fromMod}\0${toMod}\0${callType}`;
          const entry = pairCounts.get(key);
          if (entry) entry.count++;
          else pairCounts.set(key, { callType, count: 1 });
        }

        result.services = [...pairCounts.entries()]
          .map(([key, { callType, count }]) => {
            const parts = key.split('\0');
            return { from_module: parts[0], to_module: parts[1], call_type: callType, call_count: count };
          })
          .sort((a, b) => b.call_count - a.call_count)
          .slice(0, 30);
      } catch (e) {
        logQueryError('getArchitecture:services', e);
        result.services = [];
      }
    }

    if (wants('clusters')) {
      try {
        const rows = await executeQuery(repo.id, `
          MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.heuristicLabel AS label, COUNT(n) AS member_count
          ORDER BY member_count DESC
        `);
        result.clusters = rows
          .map((r: any) => ({
            label: r.label ?? r[0],
            member_count: r.member_count ?? r[1],
          }))
          .filter((c: any) => c.label && !c.label.startsWith('Cluster_')); // hide unnamed clusters
      } catch (e) {
        logQueryError('getArchitecture:clusters', e);
        result.clusters = [];
      }
    }

    return result;
  }
}
