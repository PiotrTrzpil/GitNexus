/**
 * HTTP Route Discovery — cross-service HTTP linking engine.
 *
 * Ported from codebase-memory-mcp/internal/httplink/httplink.go
 *
 * Algorithm:
 *   1. Collect RouteHandler objects from AST-extracted graph nodes
 *   2. Collect HTTPCallSite objects from function source code
 *   3. For each (callSite × route) pair: compute pathMatchScore
 *   4. Filter by min confidence (default 0.25), emit HTTPLink edges
 */

import { generateId } from '../../lib/utils.js';
import type { KnowledgeGraph } from '../graph/types.js';
import { confidenceBand, } from './http-similarity.js';
import {
  type NodeInfo,
  type HTTPCallSite,
  DEFAULT_EXCLUDE_PATHS,
  normalizePath,
  extractRoutesFromNode,
  extractCallSitesFromNode,
  extractCallSitesFromModule,
  resolveFastAPIPrefixes,
  resolveExpressPrefixes,
} from './http-patterns.js';

// ─── Exported contract types (shared across subsystems) ──────────────────────

/** RouteHandler represents a discovered HTTP route handler. */
export interface RouteHandler {
  path: string;              // '/api/users/:id'
  method: string;            // 'GET' | 'POST' | '' (any)
  functionName: string;
  qualifiedName: string;
  protocol: string;          // 'ws' | 'sse' | ''
  framework: string;         // 'express' | 'fastapi' | 'gin' | ...
  /** Resolved handler function QN (set during cross-file registration resolution). */
  resolvedHandlerQN?: string;
  /** Raw handler reference text (e.g. 'h.CreateOrder') from route registration. */
  handlerRef?: string;
}

/** HTTPLink represents a matched HTTP call from a caller to a route handler. */
export interface HTTPLink {
  sourceQN: string;          // caller function
  targetQN: string;          // route handler
  urlPath: string;
  httpMethod: string;
  confidence: number;        // 0.0 – 1.0
  isAsync: boolean;          // true for async dispatch, false for sync HTTP
}

// ─── Linker configuration ─────────────────────────────────────────────────────

export interface HTTPLinkerConfig {
  /** Minimum confidence score for creating HTTP_CALLS edges. Default: 0.25 */
  minConfidence?: number;
  /** Enable fuzzy URL matching. Default: true */
  fuzzyMatching?: boolean;
  /** Additional route paths to exclude (appended to built-in list). */
  excludePaths?: string[];
}

function effectiveMinConfidence(cfg: HTTPLinkerConfig): number {
  return cfg.minConfidence ?? 0.25;
}

function allExcludePaths(cfg: HTTPLinkerConfig): string[] {
  return [...DEFAULT_EXCLUDE_PATHS, ...(cfg.excludePaths ?? [])];
}

// ─── Path scoring ─────────────────────────────────────────────────────────────

/**
 * splitSegments splits a normalized path into non-empty segments.
 */
function splitSegments(p: string): string[] {
  return p.split('/').filter(s => s !== '');
}

/**
 * segmentJaccard computes Jaccard similarity on non-wildcard path segments.
 * Wildcards (*) are excluded from both sets since they match anything.
 */
function segmentJaccard(segsA: string[], segsB: string[]): number {
  const setA = new Set(segsA.filter(s => s !== '*'));
  const setB = new Set(segsB.filter(s => s !== '*'));

  if (setA.size === 0 && setB.size === 0) return 1.0;

  let intersection = 0;
  for (const k of setA) {
    if (setB.has(k)) intersection++;
  }

  let union = setA.size;
  for (const k of setB) {
    if (!setA.has(k)) union++;
  }

  if (union === 0) return 0;
  return intersection / union;
}

/**
 * pathMatchScore returns a confidence score (0.0–1.0) for how well callPath
 * matches routePath. Returns 0 if no match.
 *
 * Multi-signal scoring:
 *   confidence = matchBase × (0.5 × jaccard + 0.5 × depthFactor)
 *
 * Where:
 *   matchBase:   exact=0.95, suffix=0.75, wildcard=0.55
 *   jaccard:     segment Jaccard similarity (non-wildcard segments)
 *   depthFactor: min(matchedSegments / 3.0, 1.0)
 */
export function pathMatchScore(callPath: string, routePath: string): number {
  const normCall = normalizePath(callPath);
  const normRoute = normalizePath(routePath);

  if (!normCall || !normRoute) return 0;

  let matchBase: number;
  let matchedCallSegs: string[];
  let matchedRouteSegs: string[];

  if (normCall === normRoute) {
    matchBase = 0.95;
    matchedCallSegs = splitSegments(normCall);
    matchedRouteSegs = splitSegments(normRoute);
  } else if (normCall.endsWith(normRoute)) {
    matchBase = 0.75;
    matchedCallSegs = splitSegments(normRoute);
    matchedRouteSegs = splitSegments(normRoute);
  } else {
    // Segment-by-segment wildcard matching — must have equal depth
    const callParts = normCall.split('/');
    const routeParts = normRoute.split('/');
    if (callParts.length !== routeParts.length) return 0;

    for (let i = 0; i < callParts.length; i++) {
      if (callParts[i] !== routeParts[i] && callParts[i] !== '*' && routeParts[i] !== '*') {
        return 0;
      }
    }

    matchBase = 0.55;
    matchedCallSegs = splitSegments(normCall);
    matchedRouteSegs = splitSegments(normRoute);
  }

  const jaccard = segmentJaccard(matchedCallSegs, matchedRouteSegs);

  const totalSegs = matchedRouteSegs.length;
  const depthFactor = totalSegs === 0 ? 0.1 : Math.min(totalSegs / 3.0, 1.0);

  let score = matchBase * (0.5 * jaccard + 0.5 * depthFactor);
  if (score > 1.0) score = 1.0;
  return score;
}

/**
 * methodBonus returns a confidence adjustment based on HTTP method matching.
 *   +0.10 if both known and match
 *    0.00 if one or both unknown
 *   -0.15 if both known and mismatch
 */
function methodBonus(callMethod: string, routeMethod: string): number {
  if (!callMethod || !routeMethod) return 0;
  if (callMethod.toUpperCase() === routeMethod.toUpperCase()) return 0.10;
  return -0.15;
}

/**
 * sourceWeight returns a confidence multiplier based on call site source label.
 * Function/Method = 1.0, Module constants = 0.85 (may be config, not an actual call).
 */
function sourceWeight(label: string): number {
  if (label === 'Function' || label === 'Method') return 1.0;
  return 0.85;
}

// ─── Service boundary ─────────────────────────────────────────────────────────

/**
 * sameService checks if two qualified names share the same directory path.
 * Strips the last 2 segments (module file + symbol name) and compares.
 */
function sameService(qn1: string, qn2: string): boolean {
  const parts1 = qn1.split('.');
  const parts2 = qn2.split('.');
  const strip = 2;
  if (parts1.length <= strip || parts2.length <= strip) return false;
  const dir1 = parts1.slice(0, parts1.length - strip).join('.');
  const dir2 = parts2.slice(0, parts2.length - strip).join('.');
  return dir1 === dir2;
}

// ─── Path exclusion ───────────────────────────────────────────────────────────

function isPathExcluded(routePath: string, excludePaths: string[]): boolean {
  const normalized = routePath.toLowerCase().replace(/\/+$/, '');
  return excludePaths.some(
    ex => normalized === ex.toLowerCase().replace(/\/+$/, ''),
  );
}

// ─── Core matching ────────────────────────────────────────────────────────────

/**
 * matchAndLink matches HTTP call sites to route handlers using multi-signal
 * confidence scoring and returns the resulting HTTPLink array.
 *
 * This is a pure function — it does not mutate the graph. The caller is
 * responsible for writing HTTP_CALLS edges into the KnowledgeGraph.
 */
export function matchAndLink(
  routes: RouteHandler[],
  callSites: HTTPCallSite[],
  config: HTTPLinkerConfig = {},
): HTTPLink[] {
  const links: HTTPLink[] = [];
  const minConf = effectiveMinConfidence(config);
  const excludePaths = allExcludePaths(config);

  for (const cs of callSites) {
    for (const rh of routes) {
      if (sameService(cs.sourceQualifiedName, rh.qualifiedName)) continue;
      if (isPathExcluded(rh.path, excludePaths)) continue;

      const pathScore = pathMatchScore(cs.path, rh.path);
      if (pathScore === 0) continue;

      let score = pathScore * sourceWeight(cs.sourceLabel) + methodBonus(cs.method, rh.method);
      if (score < minConf) continue;
      if (score > 1.0) score = 1.0;

      links.push({
        sourceQN: cs.sourceQualifiedName,
        targetQN: rh.resolvedHandlerQN ?? rh.qualifiedName,
        urlPath: cs.path,
        httpMethod: rh.method,
        confidence: score,
        isAsync: cs.isAsync ?? false,
      });
    }
  }

  return links;
}

// ─── Graph node extraction helper ────────────────────────────────────────────

/**
 * toNodeInfoWithId converts a KnowledgeGraph node to NodeInfo with its resolved QN.
 */
function toNodeInfoWithId(
  node: import('../graph/types.js').GraphNode,
  qualifiedName: string,
): NodeInfo {
  return {
    name: node.properties.name,
    qualifiedName,
    filePath: node.properties.filePath ?? '',
    startLine: node.properties.startLine ?? 0,
    endLine: node.properties.endLine ?? 0,
    label: node.label,
    decorators: (node.properties as any).decorators ?? undefined,
    properties: node.properties as any,
  };
}

// ─── HTTPLinker class ─────────────────────────────────────────────────────────

/**
 * HTTPLinker discovers cross-service HTTP call relationships and writes
 * HTTP_CALLS edges into the KnowledgeGraph.
 *
 * Usage:
 *   const linker = new HTTPLinker(graph, repoPath, config);
 *   const links = await linker.run();
 */
export class HTTPLinker {
  private readonly config: HTTPLinkerConfig;
  /** Map from qualified name → graph node ID for edge writing. */
  private qnToNodeId = new Map<string, string>();

  constructor(
    private readonly graph: KnowledgeGraph,
    private readonly repoPath: string,
    config: HTTPLinkerConfig = {},
  ) {
    this.config = config;
  }

  /**
   * run executes the full HTTP linking pass:
   *   1. Collect routes from graph nodes
   *   2. Resolve cross-file group/use prefixes
   *   3. Collect call sites from function source
   *   4. Match and score, write HTTP_CALLS edges
   */
  async run(): Promise<HTTPLink[]> {
    const { routes, modules } = this.collectNodes();

    // Resolve framework-specific prefix patterns
    resolveFastAPIPrefixes(routes, modules, this.repoPath);
    resolveExpressPrefixes(routes, modules, this.repoPath);

    const callSites = this.collectCallSites(modules);

    const links = matchAndLink(routes, callSites, this.config);

    this.writeEdges(links);

    return links;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * collectNodes iterates graph once to build routes, modules, and qnToNodeId index.
   */
  private collectNodes(): {
    routes: (RouteHandler & { handlerRef?: string })[],
    modules: NodeInfo[],
  } {
    const routes: (RouteHandler & { handlerRef?: string })[] = [];
    const modules: NodeInfo[] = [];

    for (const node of this.graph.iterNodes()) {
      const qn: string = (node.properties as any).qualifiedName ?? node.id;
      this.qnToNodeId.set(qn, node.id);

      if (node.label === 'Function' || node.label === 'Method') {
        const info = toNodeInfoWithId(node, qn);
        routes.push(...extractRoutesFromNode(info, this.repoPath));
      } else if (node.label === 'Module') {
        modules.push(toNodeInfoWithId(node, qn));
      }
    }

    return { routes, modules };
  }

  private collectCallSites(modules: NodeInfo[]): HTTPCallSite[] {
    const sites: HTTPCallSite[] = [];

    // Module-level constants
    for (const mod of modules) {
      sites.push(...extractCallSitesFromModule(mod));
    }

    // Function/Method source
    for (const node of this.graph.iterNodes()) {
      if (node.label !== 'Function' && node.label !== 'Method') continue;
      const qn: string = (node.properties as any).qualifiedName ?? node.id;
      const info = toNodeInfoWithId(node, qn);
      sites.push(...extractCallSitesFromNode(info, this.repoPath));
    }

    return sites;
  }

  private writeEdges(links: HTTPLink[]): void {
    for (const link of links) {
      const sourceNodeId = this.qnToNodeId.get(link.sourceQN);
      const targetNodeId = this.qnToNodeId.get(link.targetQN);

      // Both endpoints must resolve to actual graph nodes
      if (!sourceNodeId || !targetNodeId) continue;

      const band = confidenceBand(link.confidence);
      const edgeId = generateId('HTTP_CALLS', `${sourceNodeId}->${targetNodeId}:${link.urlPath}`);

      this.graph.addRelationship({
        id: edgeId,
        sourceId: sourceNodeId,
        targetId: targetNodeId,
        type: link.isAsync ? 'ASYNC_CALLS' : 'HTTP_CALLS',
        confidence: link.confidence,
        reason: `${link.isAsync ? 'async' : 'http'}:${link.httpMethod || 'ANY'}:${band}`,
      });
    }
  }
}

// ─── Pipeline integration helper ─────────────────────────────────────────────

/**
 * runHTTPLinking is the top-level pipeline entry point.
 * Instantiates an HTTPLinker and runs the full pass.
 *
 * Called after call-resolution and before community detection.
 */
export async function runHTTPLinking(
  graph: KnowledgeGraph,
  repoPath: string,
  config: HTTPLinkerConfig = {},
): Promise<HTTPLink[]> {
  const linker = new HTTPLinker(graph, repoPath, config);
  return linker.run();
}
