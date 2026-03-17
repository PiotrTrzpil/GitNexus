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
import { readSourceWithContext } from '../source-reader.js';
import { findSymbol } from './symbol-lookup.js';

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
 * LadybugDB's labels(n)[0] returns the table name (always "CodeElement" etc.), not the logical label.
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
    scope?: 'unstaged' | 'staged' | 'all';
    group_commits?: boolean;
    include_body?: boolean;
  }): Promise<any> {
    const ref = params.ref ?? 'HEAD';
    const breakingOnly = params.breaking_only ?? false;
    const groupCommits = params.group_commits ?? false;
    const includeBody = params.include_body ?? false;

    // Determine files to diff: explicit list or all changed files via git
    // fileStatusMap tracks git status (A/D/M/R) per repo-relative path
    const fileStatusMap = new Map<string, 'A' | 'D' | 'M' | 'R'>();
    let filePaths: string[] = params.file_paths ?? [];
    if (filePaths.length === 0) {
      // Fall back to git diff to find changed files
      try {
        const { execSync } = await import('child_process');
        const scope = params.scope ?? 'unstaged';
        let gitCmd: string;
        if (scope === 'staged') {
          gitCmd = 'git diff --cached --name-status';
        } else if (scope === 'all') {
          gitCmd = 'git diff HEAD --name-status';
        } else {
          // unstaged: working tree vs index (no ref)
          gitCmd = 'git diff --name-status';
        }
        const raw = execSync(gitCmd, { cwd: repo.repoPath }).toString();
        filePaths = [];
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Format: "M\tpath" or "R###\told\tnew"
          const parts = trimmed.split('\t');
          const statusChar = parts[0].charAt(0) as 'A' | 'D' | 'M' | 'R';
          const status = (['A', 'D', 'M', 'R'] as const).includes(statusChar) ? statusChar : 'M';
          // For renames, use the new path (parts[2]); otherwise parts[1]
          const relPath = status === 'R' && parts[2] ? parts[2] : parts[1];
          if (relPath) {
            filePaths.push(relPath);
            fileStatusMap.set(relPath, status);
          }
        }

        // Include untracked files for 'unstaged' and 'all' scopes —
        // git diff doesn't report files that have never been tracked
        if (scope === 'unstaged' || scope === 'all') {
          const untrackedRaw = execSync(
            'git ls-files --others --exclude-standard',
            { cwd: repo.repoPath },
          ).toString();
          for (const line of untrackedRaw.split('\n')) {
            const relPath = line.trim();
            if (relPath && !fileStatusMap.has(relPath)) {
              filePaths.push(relPath);
              fileStatusMap.set(relPath, 'A');
            }
          }
        }
      } catch (err) {
        console.warn(`[semanticDiff] git diff failed for ${repo.repoPath}: ${(err as Error).message}`);
        filePaths = [];
      }
    }

    if (filePaths.length === 0) {
      const empty: any = { changes: [], summary: { total: 0, breaking: 0, byKind: {} } };
      if (groupCommits) {
        empty.commit_groups = { groups: [], ungrouped: [] };
      }
      return empty;
    }

    const allChanges = [];
    const fileSummaries: FileChangeSummary[] = [];
    for (const fp of filePaths) {
      try {
        const status = fileStatusMap.get(fp) ?? 'M';
        const fileChanges = await diffFile(repo.repoPath, fp, status, ref, { includeBody });
        allChanges.push(...fileChanges);
        if (groupCommits && fileChanges.length > 0) {
          fileSummaries.push({ path: fp, changes: fileChanges });
        }
      } catch (err) {
        console.warn(`[semanticDiff] diffFile failed for ${fp}: ${(err as Error).message}`);
      }
    }

    const filtered = breakingOnly ? allChanges.filter(c => c.isBreaking) : allChanges;

    const byKind: Record<string, number> = {};
    for (const c of filtered) {
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    }

    const result: any = {
      changes: filtered,
      summary: {
        total: filtered.length,
        breaking: filtered.filter(c => c.isBreaking).length,
        byKind,
      },
    };

    if (groupCommits) {
      // Fetch call graph edges for coupling signal
      let couplings: CouplingEdge[] = [];
      try {
        await this.ensureInitialized(repo.id);
        const rows = await this.cypher(repo, {
          query: `MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b) WHERE r.confidence >= 0.7 RETURN a.id AS sourceQN, b.id AS targetQN LIMIT 2000`,
        });
        couplings = (rows as any[]).map((r: any) => ({ fromQN: r.sourceQN, toQN: r.targetQN, type: 'CALLS' }));
      } catch {
        // Non-fatal: group without graph edges
      }

      result.commit_groups = fileSummaries.length > 0
        ? planCommits(fileSummaries, couplings)
        : { groups: [], ungrouped: [] };
    }

    return result;
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
    context_lines?: number;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const { name, uid, file_path, include_content } = params;
    const contextLines = params.context_lines ?? 3;

    if (!name && !uid) {
      return { error: 'Either "name" or "uid" parameter is required.' };
    }

    // Step 1: Find the symbol via 4-tier lookup or direct UID/file_path scoped query
    let symId: string;
    let symName: string;
    let symKind: string;
    let symFilePath: string;
    let symStartLine: number;
    let symEndLine: number;

    if (uid) {
      // Direct UID lookup — bypass 4-tier resolver
      const rows = await executeParameterized(repo.id, `
        MATCH (n {id: $uid})
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
        LIMIT 1
      `, { uid });
      if (rows.length === 0) {
        return { error: `Symbol '${uid}' not found` };
      }
      const row = rows[0];
      symId = row.id || row[0];
      symName = row.name || row[1];
      symKind = row.type || row[2];
      symFilePath = row.filePath || row[3];
      symStartLine = row.startLine || row[4];
      symEndLine = row.endLine || row[5];
    } else if (file_path) {
      // file_path-scoped lookup — not covered by findSymbol's QN tiers
      const rows = await executeParameterized(repo.id, `
        MATCH (n)
        WHERE n.name = $symName AND n.filePath CONTAINS $filePath
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
        LIMIT 10
      `, { symName: name!, filePath: file_path });
      if (rows.length === 0) {
        return { error: `Symbol '${name}' not found` };
      }
      if (rows.length > 1) {
        return {
          status: 'ambiguous',
          message: `Found ${rows.length} symbols matching '${name}'. Use uid or a more specific file_path to disambiguate.`,
          candidates: rows.map((s: any) => ({
            uid: s.id || s[0],
            name: s.name || s[1],
            kind: s.type || s[2],
            filePath: s.filePath || s[3],
            line: s.startLine || s[4],
          })),
        };
      }
      const row = rows[0];
      symId = row.id || row[0];
      symName = row.name || row[1];
      symKind = row.type || row[2];
      symFilePath = row.filePath || row[3];
      symStartLine = row.startLine || row[4];
      symEndLine = row.endLine || row[5];
    } else {
      // Name-based lookup — use shared 4-tier resolver
      const found = await findSymbol(repo.id, name!);
      if (found.kind === 'suggestions') {
        return {
          status: 'not_found',
          message: `Symbol '${name}' not found. Did you mean one of these?`,
          alternatives: found.alternatives,
          match_method: 'suggestions',
        };
      }
      // Disambiguate if multiple matches were found at any tier
      if (found.alternatives && found.alternatives.length > 0) {
        return {
          status: 'ambiguous',
          message: `Found multiple symbols matching '${name}'. Use uid or file_path to disambiguate.`,
          candidates: [
            { uid: found.node.qn, name: found.node.name, kind: found.node.label, filePath: found.node.filePath, line: found.node.startLine },
            ...found.alternatives.map(a => ({ uid: a.qn, name: a.name, kind: a.label, filePath: a.file, line: 0 })),
          ],
        };
      }
      symId = found.node.qn;
      symName = found.node.name;
      symKind = found.node.label;
      symFilePath = found.node.filePath;
      symStartLine = found.node.startLine;
      symEndLine = found.node.endLine;
    }

    // Step 3: Class/Interface hint — redirect to methods

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
            message: `${symName} is a ${symKind} — context/impact work best on functions/methods. Use one of its methods:`,
            file: symFilePath,
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

    // Read source from disk when include_content is requested
    let symbolContent: string | undefined;
    if (include_content && symFilePath && symStartLine && symEndLine) {
      try {
        const srcResult = await readSourceWithContext(repo.repoPath, symFilePath, symStartLine, symEndLine, contextLines);
        if (srcResult) {
          symbolContent = srcResult.source;
        }
      } catch (e) { logQueryError('context:read_source', e); }
    }

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
        uid: symId,
        name: symName,
        kind: symKind,
        filePath: symFilePath,
        startLine: symStartLine,
        endLine: symEndLine,
        ...(include_content && symbolContent ? { content: symbolContent } : {}),
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
      // native DB addon (LadybugDB C++ bindings are not thread-safe).
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
   * Re-run the analysis pipeline for a repo and reload the LadybugDB connection.
   * Called by the file watcher when changes are detected.
   */
  async reindexRepo(repoPath: string): Promise<void> {
    const { runPipelineFromRepo } = await import('../../core/ingestion/pipeline.js');
    const {
      initLbug: initCoreLbug,
      loadGraphToLbug,
      closeLbug: closeCoreLbug,
    } = await import('../../core/lbug/lbug-adapter.js');
    const { getStoragePaths, saveMeta, registerRepo } = await import('../../storage/repo-manager.js');
    const { getCurrentCommit } = await import('../../storage/git.js');

    const resolved = path.resolve(repoPath);
    const { storagePath, lbugPath } = getStoragePaths(resolved);

    // Close the MCP pool's read-only connection so we can write without lock conflicts
    const handle = [...this.repos.values()].find(h => h.repoPath === resolved);
    if (handle) {
      try { await closeLbug(handle.id); } catch (err) {
        console.warn(`[reindexRepo] closeLbug pool warning for ${resolved}: ${(err as Error).message}`);
      }
      this.initializedRepos.delete(handle.id);
    }

    // Re-run pipeline (no UI progress needed)
    const result = await runPipelineFromRepo(resolved, () => {});

    // Persist to LadybugDB using the core singleton adapter (write-capable).
    // Delete old db files first to avoid duplicate data (same as analyze CLI).
    await closeCoreLbug();
    for (const f of [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`]) {
      try { await fs.rm(f, { recursive: true, force: true }); } catch {}
    }
    await initCoreLbug(lbugPath);
    await loadGraphToLbug(result.graph, resolved, storagePath);
    await closeCoreLbug();

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
    name_pattern?: string;
    label?: string;
    limit?: number;
    offset?: number;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!isLbugReady(repo.id)) {
      return { error: 'LadybugDB not ready. Index may be corrupted.' };
    }

    const { preset, threshold, function: funcName, type: typeName, name_pattern, label, limit, offset } = params;

    try {
      const results = await this._runQualityPreset(repo, preset, { threshold, funcName, typeName, namePattern: name_pattern, label, limit, offset });
      return { preset, results, count: results.length };
    } catch (err: any) {
      return { error: err.message || `quality_query preset '${preset}' failed` };
    }
  }

  /** Cached per-repo check: are BasicBlock nodes present? */
  private _cfgDataCache = new Map<string, boolean>();

  private async _hasCfgData(repoId: string): Promise<boolean> {
    const cached = this._cfgDataCache.get(repoId);
    if (cached !== undefined) return cached;
    try {
      const rows = await executeQuery(repoId, `MATCH (n:BasicBlock) RETURN n.id LIMIT 1`);
      const has = rows.length > 0;
      this._cfgDataCache.set(repoId, has);
      return has;
    } catch {
      this._cfgDataCache.set(repoId, false);
      return false;
    }
  }

  /** Augment function results with CFG block counts (cfgBlocks, unreachableBlocks). */
  private async _augmentWithCfgStats(
    repoId: string,
    results: Array<{ id?: string; [k: string]: any }>,
  ): Promise<void> {
    const ids = results.map(r => r.id).filter((id): id is string => !!id);
    if (ids.length === 0) return;
    try {
      const rows = await executeQuery(repoId,
        `MATCH (n)-[:CodeRelation {type: 'CFG_CONTAINS'}]->(b:BasicBlock)
         RETURN n.id AS fnId, COUNT(b) AS total, COUNT(CASE WHEN b.isUnreachable = true THEN 1 END) AS unreachable`);
      const statsMap = new Map<string, { total: number; unreachable: number }>();
      for (const row of rows) {
        const fnId = row.fnId ?? row[0] ?? '';
        const total = row.total ?? row[1] ?? 0;
        const unreachable = row.unreachable ?? row[2] ?? 0;
        if (fnId && total > 0) statsMap.set(fnId, { total, unreachable });
      }
      for (const r of results) {
        if (!r.id) continue;
        const stats = statsMap.get(r.id);
        if (stats) {
          r.cfgBlocks = stats.total;
          if (stats.unreachable > 0) r.unreachableBlocks = stats.unreachable;
        }
      }
    } catch (err) {
      // CFG augmentation is best-effort; log but don't fail the query.
      console.warn('[CFG augment] Failed to fetch block stats:', err instanceof Error ? err.message : String(err));
    }
  }

  private async _runQualityPreset(
    repo: RepoHandle,
    preset: string,
    opts: { threshold?: number; funcName?: string; typeName?: string; namePattern?: string; label?: string; limit?: number; offset?: number },
  ): Promise<any[]> {
    const { threshold, funcName, typeName, namePattern, label, limit: rawLimit, offset: rawOffset } = opts;

    switch (preset) {

      // ── high_complexity ────────────────────────────────────────────────
      // Functions/methods with cyclomatic complexity above threshold.
      // When CFG data is available, includes cfgBlocks and unreachableBlocks.
      case 'high_complexity': {
        if (threshold === undefined) throw new Error('threshold is required for high_complexity');
        const rows = await executeParameterized(repo.id, `
          MATCH (n)
          WHERE (n.id STARTS WITH 'Function:' OR n.id STARTS WITH 'Method:' OR n.id STARTS WITH 'Constructor:')
            AND n.complexity > $threshold
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS label,
                 n.filePath AS filePath, n.startLine AS startLine,
                 n.complexity AS complexity, n.sloc AS sloc
          ORDER BY n.complexity DESC
          LIMIT 200
        `, { threshold });
        const results = rows.map((r: any) => ({
          id: r.id ?? r[0],
          name: r.name ?? r[1],
          label: r.label ?? r[2],
          filePath: r.filePath ?? r[3],
          startLine: r.startLine ?? r[4],
          complexity: r.complexity ?? r[5],
          sloc: r.sloc ?? r[6],
        }));
        if (await this._hasCfgData(repo.id)) {
          await this._augmentWithCfgStats(repo.id, results);
        }
        return results.map(({ id, ...rest }) => rest);
      }

      // ── many_optionals ────────────────────────────────────────────────
      // Functions/methods that have more than threshold optional parameters.
      case 'many_optionals': {
        if (threshold === undefined) throw new Error('threshold is required for many_optionals');
        // Fetch all functions then count optional PARAM_OF edges in JS,
        // since LadybugDB's row cap limits subquery aggregation reliability.
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
      // Uses two bulk queries instead of per-node COUNT to avoid N+1.
      case 'dead_code': {
        // Query 1: all function IDs
        const allFunctions = await executeQuery(repo.id, `
          MATCH (n)
          WHERE (n.id STARTS WITH 'Function:' OR n.id STARTS WITH 'Method:' OR n.id STARTS WITH 'Constructor:')
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS label,
                 n.filePath AS filePath, n.startLine AS startLine
        `);
        // Query 2: all CALLS target IDs (raw edges, dedupe in JS to avoid row cap on DISTINCT)
        const calledRows = await executeQuery(repo.id, `
          MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(n)
          RETURN n.id AS id
        `);
        const calledIds = new Set(calledRows.map((r: any) => r.id ?? r[0] ?? ''));

        const results: any[] = [];
        for (const r of allFunctions) {
          const id = r.id ?? r[0] ?? '';
          const filePath = r.filePath ?? r[3] ?? '';
          if (!id) continue;
          if (isTestFilePath(filePath)) continue;
          if (!calledIds.has(id)) {
            results.push({
              name: r.name ?? r[1],
              label: r.label ?? r[2],
              filePath,
              startLine: r.startLine ?? r[4],
            });
          }
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
      // Uses bulk aggregation queries instead of per-node COUNT to avoid N+1.
      case 'layer_violations': {
        // Bulk: fetch all CALLS edges, compute degrees in JS (avoids N+1 per-node queries)
        const allEdges = await executeQuery(repo.id, `
          MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
          RETURN a.id AS sourceId, b.id AS targetId
        `);
        const inDegMap = new Map<string, number>();
        const outDegMap = new Map<string, number>();
        for (const r of allEdges) {
          const src = r.sourceId ?? r[0] ?? '';
          const tgt = r.targetId ?? r[1] ?? '';
          if (src) outDegMap.set(src, (outDegMap.get(src) ?? 0) + 1);
          if (tgt) inDegMap.set(tgt, (inDegMap.get(tgt) ?? 0) + 1);
        }

        // All function metadata
        const funcRows = await executeQuery(repo.id, `
          MATCH (n)
          WHERE (n.id STARTS WITH 'Function:' OR n.id STARTS WITH 'Method:')
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath
          LIMIT 1000
        `);

        const nodeMap = new Map<string, { name: string; filePath: string; inDeg: number; outDeg: number }>();
        const entryIds = new Set<string>();
        const leafIds = new Set<string>();
        for (const r of funcRows) {
          const id = r.id ?? r[0] ?? '';
          if (!id) continue;
          const inDeg = inDegMap.get(id) ?? 0;
          const outDeg = outDegMap.get(id) ?? 0;
          nodeMap.set(id, { name: r.name ?? r[1] ?? '', filePath: r.filePath ?? r[2] ?? '', inDeg, outDeg });
          if (inDeg >= 10) entryIds.add(id);
          if (inDeg <= 1 && outDeg >= 3) leafIds.add(id);
        }

        if (leafIds.size === 0 || entryIds.size === 0) return [];

        // Reuse already-fetched edges to find leaf → entry violations
        const violations: any[] = [];
        for (const r of allEdges) {
          const callerId = r.sourceId ?? r[0] ?? '';
          const calleeId = r.targetId ?? r[1] ?? '';
          if (leafIds.has(callerId) && entryIds.has(calleeId)) {
            const leaf = nodeMap.get(callerId);
            const callee = nodeMap.get(calleeId);
            if (leaf && callee) {
              violations.push({
                caller: leaf.name,
                callerFile: leaf.filePath,
                callerInDegree: leaf.inDeg,
                callee: callee.name,
                calleeFile: callee.filePath,
                calleeInDegree: callee.inDeg,
              });
            }
          }
        }
        return violations;
      }

      // ── god_functions ─────────────────────────────────────────────────
      // Functions with high complexity AND high fan-out AND many params.
      // Thresholds: complexity > 10, outbound CALLS > 8, parameterCount > 4.
      // When CFG data is available, includes cfgBlocks and unreachableBlocks.
      // Uses bulk outbound degree aggregation to avoid N+1.
      case 'god_functions': {
        const complexityThreshold = threshold ?? 10;
        // Bulk: fetch all CALLS source IDs for outbound degree
        const callEdges = await executeQuery(repo.id, `
          MATCH (n)-[:CodeRelation {type: 'CALLS'}]->(callee)
          RETURN n.id AS sourceId
        `);
        const outDegMap = new Map<string, number>();
        for (const r of callEdges) {
          const id = r.sourceId ?? r[0] ?? '';
          if (id) outDegMap.set(id, (outDegMap.get(id) ?? 0) + 1);
        }
        // Fetch candidate functions — use try/catch for optional complexity property
        let rows: any[];
        try {
          rows = await executeParameterized(repo.id, `
            MATCH (n)
            WHERE (n.id STARTS WITH 'Function:' OR n.id STARTS WITH 'Method:')
              AND n.complexity > $complexity
              AND n.parameterCount > 4
            RETURN n.id AS id, n.name AS name, labels(n)[0] AS label,
                   n.filePath AS filePath, n.startLine AS startLine,
                   n.complexity AS complexity, n.parameterCount AS parameterCount
            ORDER BY n.complexity DESC
          `, { complexity: complexityThreshold });
        } catch {
          // complexity property may not exist on this index
          rows = [];
        }

        const hasCfg = await this._hasCfgData(repo.id);
        const results: any[] = rows
          .filter((r: any) => (outDegMap.get(r.id ?? r[0] ?? '') ?? 0) > 8)
          .map((r: any) => ({
            id: r.id ?? r[0],
            name: r.name ?? r[1],
            label: r.label ?? r[2],
            filePath: r.filePath ?? r[3],
            startLine: r.startLine ?? r[4],
            complexity: r.complexity ?? r[5],
            parameterCount: r.parameterCount ?? r[6],
            outboundCalls: outDegMap.get(r.id ?? r[0] ?? '') ?? 0,
          }));
        if (hasCfg) {
          await this._augmentWithCfgStats(repo.id, results);
        }
        return results
          .sort((a, b) => b.complexity - a.complexity)
          .map(({ id, ...rest }) => rest);
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
      // When CFG data is available, includes cfgBlocks and unreachableBlocks per function.
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
        if (await this._hasCfgData(repo.id)) {
          await this._augmentWithCfgStats(repo.id, chain);
        }
        return chain.map(({ id, ...rest }) => rest);
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

      // ── unreachable_code ──────────────────────────────────────────────
      // Functions containing statically unreachable BasicBlocks (requires CFG data).
      case 'unreachable_code': {
        if (!await this._hasCfgData(repo.id)) {
          return [{ error: 'No CFG data available. Re-run analyze without --no-cfg to generate CFG data.' }];
        }
        const rows = await executeQuery(repo.id, `
          MATCH (fn)-[:CodeRelation {type: 'CFG_CONTAINS'}]->(b:BasicBlock)
          WHERE b.isUnreachable = true
          RETURN fn.id AS fnId, fn.name AS fnName, labels(fn)[0] AS fnLabel,
                 fn.filePath AS filePath, fn.startLine AS startLine,
                 b.name AS blockName, b.startLine AS blockStartLine, b.endLine AS blockEndLine,
                 b.instructionCount AS instructionCount
          ORDER BY fn.filePath, fn.startLine
          LIMIT 200
        `);
        // Group by function
        const grouped = new Map<string, {
          name: string; label: string; filePath: string; startLine: any;
          unreachableBlocks: Array<{ blockName: string; startLine: any; endLine: any; instructionCount: any }>;
        }>();
        for (const r of rows) {
          const fnId = r.fnId ?? r[0] ?? '';
          if (!fnId) continue;
          if (!grouped.has(fnId)) {
            grouped.set(fnId, {
              name: r.fnName ?? r[1] ?? '',
              label: r.fnLabel ?? r[2] ?? '',
              filePath: r.filePath ?? r[3] ?? '',
              startLine: r.startLine ?? r[4],
              unreachableBlocks: [],
            });
          }
          grouped.get(fnId)!.unreachableBlocks.push({
            blockName: r.blockName ?? r[5] ?? '',
            startLine: r.blockStartLine ?? r[6],
            endLine: r.blockEndLine ?? r[7],
            instructionCount: r.instructionCount ?? r[8] ?? 0,
          });
        }
        const resultLimit = Math.min(rawLimit ?? 200, 200);
        const resultOffset = rawOffset ?? 0;
        return [...grouped.values()].slice(resultOffset, resultOffset + resultLimit);
      }

      // ── cfg_complexity ─────────────────────────────────────────────────
      // True cyclomatic complexity from CFG: (edges − blocks + 2P) per function,
      // where P = number of connected components (accounts for disconnected
      // subgraphs after ErrorImplicit edge filtering).
      // Requires CFG data. threshold defaults to 5.
      case 'cfg_complexity': {
        if (!await this._hasCfgData(repo.id)) {
          return [{ error: 'No CFG data available. Re-run analyze without --no-cfg to generate CFG data.' }];
        }
        const cfgThreshold = threshold ?? 5;
        // Single query: fetch block IDs + function metadata together
        const blockIdRows = await executeQuery(repo.id, `
          MATCH (fn)-[:CodeRelation {type: 'CFG_CONTAINS'}]->(b:BasicBlock)
          RETURN fn.id AS fnId, fn.name AS fnName, labels(fn)[0] AS fnLabel,
                 fn.filePath AS filePath, fn.startLine AS startLine,
                 fn.complexity AS astComplexity, fn.sloc AS sloc,
                 b.id AS blockId
        `);
        // Group blocks by function and collect metadata
        const fnBlockIds = new Map<string, Set<string>>();
        const fnMap = new Map<string, {
          name: string; label: string; filePath: string; startLine: any;
          astComplexity: any; sloc: any;
        }>();
        for (const r of blockIdRows) {
          const fnId = r.fnId ?? r[0] ?? '';
          const blockId = r.blockId ?? r[7] ?? '';
          if (!fnId || !blockId) continue;
          if (!fnBlockIds.has(fnId)) fnBlockIds.set(fnId, new Set());
          fnBlockIds.get(fnId)!.add(blockId);
          if (!fnMap.has(fnId)) {
            fnMap.set(fnId, {
              name: r.fnName ?? r[1] ?? '',
              label: r.fnLabel ?? r[2] ?? '',
              filePath: r.filePath ?? r[3] ?? '',
              startLine: r.startLine ?? r[4],
              astComplexity: r.astComplexity ?? r[5],
              sloc: r.sloc ?? r[6],
            });
          }
        }
        // Fetch CFG_EDGE pairs
        const edgeRows = await executeQuery(repo.id, `
          MATCH (b1:BasicBlock)-[:CodeRelation {type: 'CFG_EDGE'}]->(b2:BasicBlock)
          RETURN b1.id AS srcId, b2.id AS tgtId
        `);
        // Reverse lookup: blockId → fnId
        const blockToFn = new Map<string, string>();
        for (const [fnId, blockIds] of fnBlockIds) {
          for (const bid of blockIds) {
            blockToFn.set(bid, fnId);
          }
        }
        // Count edges and collect adjacency lists per function for connected-component analysis
        const fnEdgeCounts = new Map<string, number>();
        const fnAdjacency = new Map<string, Map<string, Set<string>>>();
        for (const r of edgeRows) {
          const srcId = r.srcId ?? r[0] ?? '';
          const tgtId = r.tgtId ?? r[1] ?? '';
          const fnId = blockToFn.get(srcId);
          if (fnId) {
            fnEdgeCounts.set(fnId, (fnEdgeCounts.get(fnId) ?? 0) + 1);
            // Build undirected adjacency for connected-component counting
            if (!fnAdjacency.has(fnId)) fnAdjacency.set(fnId, new Map());
            const adj = fnAdjacency.get(fnId)!;
            if (!adj.has(srcId)) adj.set(srcId, new Set());
            if (!adj.has(tgtId)) adj.set(tgtId, new Set());
            adj.get(srcId)!.add(tgtId);
            adj.get(tgtId)!.add(srcId);
          }
        }
        const results: any[] = [];
        for (const [fnId, fn] of fnMap) {
          const blockIds = fnBlockIds.get(fnId)!;
          const edgeCount = fnEdgeCounts.get(fnId) ?? 0;
          const blockCount = blockIds.size;
          // Count connected components via BFS over the undirected adjacency graph.
          // Blocks with no edges are each their own component.
          const adj = fnAdjacency.get(fnId);
          let components = 0;
          const visited = new Set<string>();
          for (const bid of blockIds) {
            if (visited.has(bid)) continue;
            components++;
            // BFS from this block
            const queue = [bid];
            visited.add(bid);
            while (queue.length > 0) {
              const cur = queue.pop()!;
              const neighbors = adj?.get(cur);
              if (neighbors) {
                for (const nb of neighbors) {
                  if (!visited.has(nb)) {
                    visited.add(nb);
                    queue.push(nb);
                  }
                }
              }
            }
          }
          // M = E - N + 2P (generalized cyclomatic complexity)
          const cfgCyclomaticComplexity = edgeCount - blockCount + 2 * components;
          if (cfgCyclomaticComplexity > cfgThreshold) {
            results.push({
              name: fn.name,
              label: fn.label,
              filePath: fn.filePath,
              startLine: fn.startLine,
              cfgComplexity: cfgCyclomaticComplexity,
              astComplexity: fn.astComplexity,
              cfgBlocks: blockCount,
              cfgEdges: edgeCount,
              sloc: fn.sloc,
            });
          }
        }
        const resultLimit = Math.min(rawLimit ?? 200, 200);
        const resultOffset = rawOffset ?? 0;
        return results.sort((a, b) => b.cfgComplexity - a.cfgComplexity).slice(resultOffset, resultOffset + resultLimit);
      }

      // ── hotspots ──────────────────────────────────────────────────────
      // Functions/methods with the highest number of inbound CALLS edges.
      // Surfaces the most-called code — useful for finding high-impact refactoring targets.
      // Fetches all CALLS edges once and computes degrees in JS (avoids N+1 per-node queries).
      case 'hotspots': {
        const resultLimit = Math.min(rawLimit ?? 20, 100);
        const resultOffset = rawOffset ?? 0;
        // Bulk: all CALLS target IDs
        const edgeRows = await executeQuery(repo.id, `
          MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(n)
          RETURN n.id AS targetId
        `);
        const inDegMap = new Map<string, number>();
        for (const r of edgeRows) {
          const id = r.targetId ?? r[0] ?? '';
          if (id) inDegMap.set(id, (inDegMap.get(id) ?? 0) + 1);
        }
        // Top N by inbound degree
        const topIds = [...inDegMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(resultOffset, resultOffset + resultLimit);
        // Fetch metadata for the top IDs
        const results: any[] = [];
        for (const [id, inDeg] of topIds) {
          try {
            const metaRows = await executeParameterized(repo.id,
              `MATCH (n {id: $id}) RETURN n.name AS name, labels(n)[0] AS label, n.filePath AS filePath, n.startLine AS startLine`,
              { id });
            if (metaRows.length > 0) {
              const r = metaRows[0];
              results.push({
                name: r.name ?? r[0] ?? '',
                label: r.label ?? r[1] ?? '',
                filePath: r.filePath ?? r[2] ?? '',
                startLine: r.startLine ?? r[3],
                inboundCalls: inDeg,
              });
            }
          } catch {}
        }
        return results;
      }

      // ── high_fan_out ──────────────────────────────────────────────────
      // Functions/methods with the highest number of outbound CALLS edges.
      // Surfaces functions that depend on many others — candidates for decomposition.
      // Fetches all CALLS edges once and computes degrees in JS.
      case 'high_fan_out': {
        const resultLimit = Math.min(rawLimit ?? 20, 100);
        const resultOffset = rawOffset ?? 0;
        // Bulk: all CALLS source IDs
        const edgeRows = await executeQuery(repo.id, `
          MATCH (n)-[:CodeRelation {type: 'CALLS'}]->(callee)
          RETURN n.id AS sourceId
        `);
        const outDegMap = new Map<string, number>();
        for (const r of edgeRows) {
          const id = r.sourceId ?? r[0] ?? '';
          if (id) outDegMap.set(id, (outDegMap.get(id) ?? 0) + 1);
        }
        const topIds = [...outDegMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(resultOffset, resultOffset + resultLimit);
        const results: any[] = [];
        for (const [id, outDeg] of topIds) {
          try {
            const metaRows = await executeParameterized(repo.id,
              `MATCH (n {id: $id}) RETURN n.name AS name, labels(n)[0] AS label, n.filePath AS filePath, n.startLine AS startLine`,
              { id });
            if (metaRows.length > 0) {
              const r = metaRows[0];
              results.push({
                name: r.name ?? r[0] ?? '',
                label: r.label ?? r[1] ?? '',
                filePath: r.filePath ?? r[2] ?? '',
                startLine: r.startLine ?? r[3],
                outboundCalls: outDeg,
              });
            }
          } catch {}
        }
        return results;
      }

      // ── by_name ───────────────────────────────────────────────────────
      // Find nodes matching a name regex, with an optional label filter.
      // Accepts namePattern (required) and label (optional) from opts.
      case 'by_name': {
        if (!namePattern) throw new Error('name_pattern is required for by_name');
        if (label && !VALID_NODE_LABELS.has(label)) {
          throw new Error(`Invalid label: ${label}. Valid labels: ${[...VALID_NODE_LABELS].join(', ')}`);
        }
        const resultLimit = Math.min(rawLimit ?? 20, 100);
        const resultOffset = rawOffset ?? 0;
        const matchClause = label ? `MATCH (n:\`${label}\`)` : 'MATCH (n)';
        const rows = await executeParameterized(repo.id, `
          ${matchClause}
          WHERE n.name =~ $namePattern
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS label,
                 n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
          ORDER BY n.name
          LIMIT ${resultOffset + resultLimit}
        `, { namePattern });
        const results = rows.map((r: any) => {
          const startLine = r.startLine ?? r[4];
          const endLine = r.endLine ?? r[5];
          const lines = (startLine != null && endLine != null)
            ? `${startLine}-${endLine}`
            : (startLine != null ? String(startLine) : '');
          return {
            name: r.name ?? r[1] ?? '',
            label: r.label ?? r[2] ?? '',
            filePath: r.filePath ?? r[3] ?? '',
            lines,
          };
        });
        return results.slice(resultOffset);
      }

      default:
        throw new Error(`Unknown quality_query preset: ${preset}. Valid presets: high_complexity, many_optionals, dead_code, cross_class_field_access, encapsulation_violations, unused_injections, overused_injections, params_by_type, param_fan_in, type_coupling, layer_violations, god_functions, throw_diversity, accessor_vs_direct, conditional_calls, hot_path, guarded_paths, unreachable_code, cfg_complexity, hotspots, high_fan_out, by_name`);
    }
  }

}
