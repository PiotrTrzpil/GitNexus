/**
 * Per-framework HTTP route and call-site extraction patterns.
 *
 * Ported from codebase-memory-mcp/internal/httplink/httplink.go
 * (regex patterns, extractXxxRoutes, discoverCallSites helpers).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RouteHandler } from './http-linker.js';

// ─── Compiled regexes ────────────────────────────────────────────────────────

// Python decorators: @app.post("/path"), @router.get("/path")
const pyRouteRe = /@\w+\.(get|post|put|delete|patch)\(\s*["']([^"']*)["']/gi;

// Python WebSocket routes: @app.websocket("/path")
const pyWSRouteRe = /@\w+\.websocket\(\s*["']([^"']*)["']/gi;

// Go gin/chi routes: .POST("/path"), .Get("/path")
const goRouteRe = /\.(GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)\(\s*["']([^"']*)["']/g;

// Go gin group: .Group("/prefix")
const goGroupRe = /(\w+)\s*(?::=|=)\s*\w+\.Group\(\s*["']([^"']+)["']/g;

// Go gin/chi route handler reference: captures the last argument
const goRouteHandlerRe = /\.(GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)\s*\(\s*"[^"]*"\s*(?:,\s*[\w.]+)*,\s*([\w.]+)\s*\)/g;

// Go chi: r.Route("/prefix", func(r chi.Router) { ... })
const goChiRouteRe = /\.Route\(\s*"([^"]+)"\s*,\s*func/g;

// Express.js routes: (receiver).(method)("path")
const expressRouteRe = /(\w+)\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/gi;

// Express.js handler reference
const expressHandlerRe = /(\w+)\.(get|post|put|delete|patch)\(\s*["'`][^"'`]+["'`]\s*(?:,\s*[\w.]+)*,\s*([\w.]+)\s*\)/gi;

// Java Spring annotations: @GetMapping("/path"), @PostMapping, @RequestMapping
const springMappingRe = /@(Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;

// Spring WebSocket: @MessageMapping("/path")
const springWSRe = /@MessageMapping\(\s*["']([^"']+)["']/g;

// Rust Actix annotations: #[get("/path")], #[post("/path")]
const actixRouteRe = /#\[(get|post|put|delete|patch)\(\s*"([^"]+)"/g;

// PHP Laravel routes: Route::get("/path", ...
const laravelRouteRe = /Route::(get|post|put|delete|patch)\(\s*["']([^"']+)["']/gi;

// Laravel handler: Route::get("/path", [Controller::class, "method"])
const laravelHandlerArrayRe = /Route::(get|post|put|delete|patch)\(\s*["'][^"']+["']\s*,\s*\[(\w+)::class\s*,\s*["'](\w+)["']\]/gi;

// Laravel handler: Route::get("/path", "Controller@method")
const laravelHandlerAtRe = /Route::(get|post|put|delete|patch)\(\s*["'][^"']+["']\s*,\s*["'](\w+)@(\w+)["']/gi;

// C# ASP.NET: [HttpGet("/path")], [HttpPost...]
const aspnetRouteRe = /\[(Http(?:Get|Post|Put|Delete|Patch))\(\s*"([^"]+)"/g;

// C# ASP.NET: [Route("/path")]
const aspnetRouteAttrRe = /\[Route\(\s*"([^"]+)"/g;

// Kotlin Ktor: get("/path") {, post("/path") {
const ktorRouteRe = /\b(get|post|put|delete|patch)\(\s*"([^"]+)"\s*\)/gi;

// Kotlin Ktor WebSocket: webSocket("/path") {
const ktorWSRe = /\bwebSocket\(\s*"([^"]+)"\s*\)/g;

// FastAPI prefix: app.include_router(var, prefix="/prefix")
const fastAPIIncludeRe = /\.include_router\(\s*(\w+)\s*,\s*prefix\s*=\s*["']([^"']+)["']/g;

// Python import: from module.path import var_name
const pyImportRe = /from\s+([\w.]+)\s+import\s+(\w+)/g;

// Express prefix: app.use("/prefix", routerVar)
const expressUseRe = /\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\w+)/g;

// JS/TS import patterns for router variable resolution
const jsRequireRe = /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']([^"']+)["']/g;
const jsImportRe = /import\s+(\w+)\s+from\s+["']([^"']+)["']/g;

// Path param normalizers
const colonParamRe = /:[a-zA-Z_]+/g;
const braceParamRe = /\{[a-zA-Z_]+\}/g;
const numericSegmentRe = /\/\d+(\/|$)/g;
const uuidSegmentRe = /\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(\/|$)/g;

// Full URL: https://host/path
const urlRe = /https?:\/\/([a-zA-Z0-9.\-]+)((?:\/[a-zA-Z0-9_:.\\-]*)+)/g;

// Path-only: "/api/something"
const pathRe = /["']((?:\/[a-zA-Z0-9_:.\\-]*){2,})["']/g;

// ─── Express receiver allowlist ───────────────────────────────────────────────

const expressReceiverAllowlist = new Set([
  'app', 'router', 'server', 'api', 'routes', 'express', 'route',
]);

// ─── Well-known external domains ─────────────────────────────────────────────

const externalDomains = [
  'googleapis.com', 'google.com', 'github.com', 'gitlab.com',
  'docker.com', 'docker.io', 'npmjs.org', 'pypi.org',
  'cloudflare.com', 'sentry.io', 'aws.amazon.com',
];

function isExternalDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return externalDomains.some(ext => lower === ext || lower.endsWith('.' + ext));
}

// ─── Default exclude paths ────────────────────────────────────────────────────

export const DEFAULT_EXCLUDE_PATHS = [
  '/health', '/healthz', '/ready', '/readyz', '/metrics', '/favicon.ico',
];

// ─── HTTP client / async dispatch keywords ────────────────────────────────────

export const HTTP_CLIENT_KEYWORDS = [
  // Python
  'requests.get', 'requests.post', 'requests.put', 'requests.delete', 'requests.patch',
  'httpx.', 'aiohttp.', 'urllib.request',
  // Go
  'http.Get', 'http.Post', 'http.NewRequest', 'client.Do(',
  // JavaScript/TypeScript
  'fetch(', 'axios.', '.ajax(',
  // Java
  'HttpClient', 'RestTemplate', 'WebClient', 'OkHttpClient',
  'HttpURLConnection', 'openConnection(',
  // Rust
  'reqwest::', 'hyper::', 'surf::', 'ureq::',
  // PHP
  'curl_exec', 'curl_init', 'Guzzle', 'Http::get', 'Http::post',
  // Scala
  'sttp.', 'http4s', 'wsClient',
  // C++
  'curl_easy', 'cpr::Get', 'cpr::Post', 'httplib::',
  // Lua
  'socket.http', 'http.request', 'curl.',
  // C#
  'WebClient', 'RestClient', 'HttpWebRequest',
  // Kotlin
  'OkHttpClient', 'ktor.client',
  // Generic
  'send_request', 'http_client',
];

export const ASYNC_DISPATCH_KEYWORDS = [
  'CreateTask', 'create_task',
  'topic.Publish', 'publisher.publish', 'topic.publish',
  'sqs.send_message', 'sns.publish',
  'basic_publish',
  'producer.send', 'producer.Send',
];

const WS_PATTERNS = [
  'websocket.Upgrade', 'websocket.Accept', 'upgrader.Upgrade',
  `ws.on("connection`, `io.on("connection`, 'new WebSocket(',
  'WebSocketSession', 'wsHandler',
];

const SSE_PATTERNS = [
  'text/event-stream', 'EventSourceResponse', 'SseEmitter',
  'ServerSentEvent', 'event-stream',
];

// ─── NodeInfo shape (lightweight — avoids importing full graph types) ─────────

/** Minimal representation of a graph node for route extraction. */
export interface NodeInfo {
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  label: string;
  decorators?: string[];
  /** arbitrary extra properties (constants, is_test, etc.) */
  properties?: Record<string, any>;
}

/** HTTPCallSite represents a discovered HTTP call site within source code. */
export interface HTTPCallSite {
  path: string;
  method: string;          // 'GET' | 'POST' | ... | '' if unknown
  sourceQualifiedName: string;
  sourceName: string;
  sourceLabel: string;     // 'Function' | 'Method' | 'Module'
  isAsync: boolean;
}

// ─── Path normalization ───────────────────────────────────────────────────────

/** normalizePath normalizes a URL path for comparison. */
export function normalizePath(p: string): string {
  p = p.replace(/\/+$/, '');                               // trim trailing slash
  p = p.replace(colonParamRe, '*');                        // :id → *
  p = p.replace(braceParamRe, '*');                        // {id} → *
  p = p.replace(uuidSegmentRe, '/*$1');                    // /uuid-... → /*
  p = p.replace(numericSegmentRe, '/*$1');                 // /123 → /*
  return p.toLowerCase();
}

// ─── URL path extraction ──────────────────────────────────────────────────────

/** extractURLPaths finds URL path segments from text (like Go ExtractURLPaths). */
export function extractURLPaths(text: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  // Full URLs: extract domain + path, skip external
  for (const m of text.matchAll(new RegExp(urlRe.source, 'g'))) {
    const domain = m[1];
    const p = m[2];
    if (isExternalDomain(domain)) continue;
    if (!seen.has(p)) { seen.add(p); paths.push(p); }
  }

  // Quoted path literals
  for (const m of text.matchAll(new RegExp(pathRe.source, 'g'))) {
    const p = m[1];
    if (!seen.has(p)) { seen.add(p); paths.push(p); }
  }

  // Embedded JSON string paths
  for (const p of extractJSONStringPaths(text)) {
    if (!seen.has(p)) { seen.add(p); paths.push(p); }
  }

  return paths;
}

function extractJSONStringPaths(text: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const jsonStr of findJSONBounds(text)) {
    let parsed: any;
    try { parsed = JSON.parse(jsonStr); } catch { continue; }
    walkJSONForURLs(parsed, paths, seen);
  }

  return paths;
}

function findJSONBounds(text: string): string[] {
  return [
    ...scanJSONBlocks(text, '{', '}'),
    ...scanJSONBlocks(text, '[', ']'),
  ];
}

function scanJSONBlocks(text: string, opener: string, closer: string): string[] {
  const results: string[] = [];
  let start = text.indexOf(opener);
  while (start >= 0 && start < text.length) {
    const end = findBalancedEnd(text, start, opener, closer);
    if (end < 0) break;
    const candidate = text.slice(start, end + 1);
    if (candidate.length > 5) results.push(candidate);
    const next = text.indexOf(opener, end + 1);
    if (next < 0) break;
    start = next;
  }
  return results;
}

function findBalancedEnd(text: string, start: number, opener: string, closer: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === opener) { depth++; continue; }
    if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function walkJSONForURLs(v: any, out: string[], seen: Set<string>): void {
  if (typeof v === 'string') {
    for (const m of v.matchAll(new RegExp(urlRe.source, 'g'))) {
      if (!isExternalDomain(m[1]) && !seen.has(m[2])) {
        seen.add(m[2]); out.push(m[2]);
      }
    }
    for (const m of (`"${v}"`).matchAll(new RegExp(pathRe.source, 'g'))) {
      if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    }
  } else if (Array.isArray(v)) {
    for (const child of v) walkJSONForURLs(child, out, seen);
  } else if (v && typeof v === 'object') {
    for (const child of Object.values(v)) walkJSONForURLs(child, out, seen);
  }
}

// ─── Protocol detection ───────────────────────────────────────────────────────

export function detectProtocol(source: string): 'ws' | 'sse' | '' {
  for (const p of WS_PATTERNS) {
    if (source.includes(p)) return 'ws';
  }
  for (const p of SSE_PATTERNS) {
    if (source.includes(p)) return 'sse';
  }
  return '';
}

// ─── HTTP method detection ────────────────────────────────────────────────────

export function detectHTTPMethod(source: string): string {
  const upper = source.toUpperCase();
  for (const verb of ['POST', 'PUT', 'DELETE', 'PATCH', 'GET']) {
    if (upper.includes('REQUESTS.' + verb + '(') || upper.includes('HTTPX.' + verb + '(')) return verb;
    if (upper.includes(`"${verb}"`) && upper.includes('HTTP.')) return verb;
    if (upper.includes('METHOD') && upper.includes(verb)) return verb;
    if (upper.includes('HTTPMETHOD.' + verb)) return verb;
    if (source.includes('.' + verb.toLowerCase() + '(')) return verb;
    if (upper.includes('CURLOPT') && upper.includes(verb)) return verb;
  }
  return '';
}

// ─── Test file detection ──────────────────────────────────────────────────────

function isTestFile(filePath: string): boolean {
  const fp = filePath.replace(/\\/g, '/');
  return (
    fp.startsWith('test/') || fp.includes('/test/') ||
    fp.startsWith('tests/') || fp.includes('/tests/') ||
    fp.startsWith('__tests__/') || fp.includes('/__tests__/') ||
    fp.includes('_test.') || fp.includes('.test.') || fp.includes('.spec.')
  );
}

// ─── Source reading helpers ───────────────────────────────────────────────────

export function readSourceLines(rootPath: string, relPath: string, startLine: number, endLine: number): string {
  try {
    const absPath = path.join(rootPath, relPath);
    const content = fs.readFileSync(absPath, 'utf8');
    const lines = content.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    return '';
  }
}

export function readSourceFull(rootPath: string, relPath: string): string {
  try {
    return fs.readFileSync(path.join(rootPath, relPath), 'utf8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    return '';
  }
}

// ─── Framework-specific route extractors ─────────────────────────────────────

export function extractPythonRoutes(node: NodeInfo): RouteHandler[] {
  const routes: RouteHandler[] = [];
  const decs = node.decorators ?? [];

  for (const dec of decs) {
    // Standard HTTP routes
    for (const m of dec.matchAll(new RegExp(pyRouteRe.source, 'gi'))) {
      routes.push({
        path: m[2],
        method: m[1].toUpperCase(),
        functionName: node.name,
        qualifiedName: node.qualifiedName,
        protocol: '',
        framework: 'fastapi',
      });
    }
    // WebSocket routes
    for (const m of dec.matchAll(new RegExp(pyWSRouteRe.source, 'gi'))) {
      routes.push({
        path: m[1],
        method: 'WS',
        functionName: node.name,
        qualifiedName: node.qualifiedName,
        protocol: 'ws',
        framework: 'fastapi',
      });
    }
  }

  return routes;
}

export function extractJavaRoutes(node: NodeInfo): RouteHandler[] {
  const routes: RouteHandler[] = [];
  const decs = node.decorators ?? [];

  for (const dec of decs) {
    for (const m of dec.matchAll(new RegExp(springMappingRe.source, 'g'))) {
      let method = m[1].toUpperCase();
      if (method === 'REQUEST') method = '';
      routes.push({
        path: m[2],
        method,
        functionName: node.name,
        qualifiedName: node.qualifiedName,
        protocol: '',
        framework: 'spring',
      });
    }
    for (const m of dec.matchAll(new RegExp(springWSRe.source, 'g'))) {
      routes.push({
        path: m[1],
        method: 'WS',
        functionName: node.name,
        qualifiedName: node.qualifiedName,
        protocol: 'ws',
        framework: 'spring',
      });
    }
  }

  return routes;
}

export function extractRustRoutes(node: NodeInfo): RouteHandler[] {
  const routes: RouteHandler[] = [];
  const decs = node.decorators ?? [];

  for (const dec of decs) {
    for (const m of dec.matchAll(new RegExp(actixRouteRe.source, 'g'))) {
      routes.push({
        path: m[2],
        method: m[1].toUpperCase(),
        functionName: node.name,
        qualifiedName: node.qualifiedName,
        protocol: '',
        framework: 'actix',
      });
    }
  }

  return routes;
}

export function extractASPNetRoutes(node: NodeInfo): RouteHandler[] {
  const routes: RouteHandler[] = [];
  const decs = node.decorators ?? [];

  for (const dec of decs) {
    for (const m of dec.matchAll(new RegExp(aspnetRouteRe.source, 'g'))) {
      const method = m[1].replace(/^Http/i, '').toUpperCase();
      routes.push({
        path: m[2],
        method,
        functionName: node.name,
        qualifiedName: node.qualifiedName,
        protocol: '',
        framework: 'aspnet',
      });
    }
    for (const m of dec.matchAll(new RegExp(aspnetRouteAttrRe.source, 'g'))) {
      routes.push({
        path: m[1],
        method: '',
        functionName: node.name,
        qualifiedName: node.qualifiedName,
        protocol: '',
        framework: 'aspnet',
      });
    }
  }

  return routes;
}

export function extractGoRoutes(node: NodeInfo, source: string): RouteHandler[] {
  const routes: RouteHandler[] = [];

  // Build map of variable name → group prefix from gin Group() calls
  const groupPrefixes = new Map<string, string>();
  for (const m of source.matchAll(new RegExp(goGroupRe.source, 'g'))) {
    groupPrefixes.set(m[1], m[2]);
  }

  // Chi Route() prefix stack
  interface ChiBlock { prefix: string; depth: number; }
  const chiStack: ChiBlock[] = [];
  let braceDepth = 0;

  for (const line of source.split('\n')) {
    // Detect chi .Route("/prefix", func...) blocks
    const chiM = line.match(new RegExp(goChiRouteRe.source));
    if (chiM) {
      chiStack.push({ prefix: chiM[1], depth: braceDepth });
    }

    // Track brace depth
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    // Pop closed chi blocks
    while (chiStack.length > 0 && braceDepth <= chiStack[chiStack.length - 1].depth) {
      chiStack.pop();
    }

    const rm = line.match(new RegExp(goRouteRe.source));
    if (!rm) continue;

    const method = rm[1].toUpperCase();
    let routePath = rm[2];

    if (chiStack.length > 0) {
      let fullPrefix = '';
      for (const block of chiStack) {
        fullPrefix = fullPrefix.replace(/\/$/, '') + '/' + block.prefix.replace(/^\//, '');
      }
      if (routePath === '/' || routePath === '') {
        routePath = fullPrefix;
      } else {
        routePath = fullPrefix.replace(/\/$/, '') + '/' + routePath.replace(/^\//, '');
      }
    } else {
      routePath = resolveGoGroupPrefix(line, rm[1], routePath, groupPrefixes);
    }

    // Capture handler reference
    let handlerRef = '';
    const hm = line.match(new RegExp(goRouteHandlerRe.source));
    if (hm) handlerRef = hm[2];

    routes.push({
      path: routePath,
      method,
      functionName: node.name,
      qualifiedName: node.qualifiedName,
      protocol: '',
      framework: 'gin',
      handlerRef: handlerRef || undefined,
    });
  }

  return routes;
}

function resolveGoGroupPrefix(
  line: string,
  method: string,
  routePath: string,
  groupPrefixes: Map<string, string>,
): string {
  const idx = line.indexOf('.' + method + '(');
  if (idx <= 0) return routePath;
  const prefix = line.slice(0, idx).trim();
  const parts = prefix.split(/\s+/);
  if (parts.length === 0) return routePath;
  const receiver = parts[parts.length - 1];
  const gp = groupPrefixes.get(receiver);
  if (!gp) return routePath;
  const resolved = gp.replace(/\/$/, '') + '/' + routePath.replace(/^\//, '');
  if (resolved === '/') return gp;
  return resolved;
}

export function extractExpressRoutes(node: NodeInfo, source: string): RouteHandler[] {
  const routes: RouteHandler[] = [];

  for (const line of source.split('\n')) {
    const rm = line.match(new RegExp(expressRouteRe.source, 'i'));
    if (!rm) continue;

    const receiver = rm[1].toLowerCase();
    if (!expressReceiverAllowlist.has(receiver)) continue;

    // Express overload: .get() with 1 arg is a config getter
    if (rm[2].toLowerCase() === 'get') {
      const matchEnd = line.indexOf(rm[0]) + rm[0].length;
      const rest = line.slice(matchEnd).trimStart();
      if (!rest.startsWith(',')) continue;
    }

    let handlerRef: string | undefined;
    const hm = line.match(new RegExp(expressHandlerRe.source, 'i'));
    if (hm) handlerRef = hm[3];

    routes.push({
      path: rm[3],
      method: rm[2].toUpperCase(),
      functionName: node.name,
      qualifiedName: node.qualifiedName,
      protocol: '',
      framework: 'express',
      handlerRef,
    });
  }

  return routes;
}

export function extractLaravelRoutes(node: NodeInfo, source: string): RouteHandler[] {
  const routes: RouteHandler[] = [];

  for (const line of source.split('\n')) {
    const rm = line.match(new RegExp(laravelRouteRe.source, 'i'));
    if (!rm) continue;

    let handlerRef: string | undefined;
    const am = line.match(new RegExp(laravelHandlerArrayRe.source, 'i'));
    if (am) {
      handlerRef = am[3];
    } else {
      const atm = line.match(new RegExp(laravelHandlerAtRe.source, 'i'));
      if (atm) handlerRef = atm[3];
    }

    routes.push({
      path: rm[2],
      method: rm[1].toUpperCase(),
      functionName: node.name,
      qualifiedName: node.qualifiedName,
      protocol: '',
      framework: 'laravel',
      handlerRef,
    });
  }

  return routes;
}

export function extractKtorRoutes(node: NodeInfo, source: string): RouteHandler[] {
  const routes: RouteHandler[] = [];

  for (const line of source.split('\n')) {
    const rm = line.match(new RegExp(ktorRouteRe.source, 'i'));
    if (rm) {
      routes.push({
        path: rm[2],
        method: rm[1].toUpperCase(),
        functionName: node.name,
        qualifiedName: node.qualifiedName,
        protocol: '',
        framework: 'ktor',
      });
      continue;
    }
    const wm = line.match(new RegExp(ktorWSRe.source));
    if (wm) {
      routes.push({
        path: wm[1],
        method: 'WS',
        functionName: node.name,
        qualifiedName: node.qualifiedName,
        protocol: 'ws',
        framework: 'ktor',
      });
    }
  }

  return routes;
}

// ─── Route extraction entry point ────────────────────────────────────────────

/**
 * extractRoutesFromNode extracts all route handlers from a single graph node
 * (Function/Method/Module) using all applicable framework patterns.
 */
export function extractRoutesFromNode(
  node: NodeInfo,
  rootPath: string,
): RouteHandler[] {
  if (isTestFile(node.filePath)) return [];

  const routes: RouteHandler[] = [];

  // Decorator-based extraction (Python, Java, Rust, C#)
  routes.push(...extractPythonRoutes(node));
  routes.push(...extractJavaRoutes(node));
  routes.push(...extractRustRoutes(node));
  routes.push(...extractASPNetRoutes(node));

  // Source-based extraction (Go, Express, Laravel, Ktor)
  if (node.filePath && node.startLine > 0 && node.endLine > 0) {
    const source = readSourceLines(rootPath, node.filePath, node.startLine, node.endLine);
    if (source) {
      routes.push(...extractGoRoutes(node, source));
      routes.push(...extractExpressRoutes(node, source));
      routes.push(...extractLaravelRoutes(node, source));
      routes.push(...extractKtorRoutes(node, source));
    }
  }

  return routes;
}

/**
 * extractCallSitesFromNode extracts HTTP call sites from a Function/Method node.
 */
export function extractCallSitesFromNode(
  node: NodeInfo,
  rootPath: string,
): HTTPCallSite[] {
  const sites: HTTPCallSite[] = [];

  if (!node.filePath || node.startLine <= 0 || node.endLine <= 0) return sites;

  // Skip Python dunder methods
  if (node.name.startsWith('__') && node.name.endsWith('__')) return sites;

  const source = readSourceLines(rootPath, node.filePath, node.startLine, node.endLine);
  if (!source) return sites;

  const hasHTTPClient = HTTP_CLIENT_KEYWORDS.some(kw => source.includes(kw));
  const hasAsyncDispatch = ASYNC_DISPATCH_KEYWORDS.some(kw => source.includes(kw));

  if (!hasHTTPClient && !hasAsyncDispatch) return sites;

  // Sync takes precedence over async
  const isAsync = hasAsyncDispatch && !hasHTTPClient;
  const method = detectHTTPMethod(source);

  for (const p of extractURLPaths(source)) {
    sites.push({
      path: p,
      method,
      sourceQualifiedName: node.qualifiedName,
      sourceName: node.name,
      sourceLabel: node.label,
      isAsync,
    });
  }

  return sites;
}

/**
 * extractCallSitesFromModule extracts HTTP paths from module-level constants.
 */
export function extractCallSitesFromModule(node: NodeInfo): HTTPCallSite[] {
  const sites: HTTPCallSite[] = [];
  const constants = node.properties?.['constants'];
  if (!Array.isArray(constants)) return sites;

  for (const c of constants) {
    if (typeof c !== 'string') continue;
    for (const p of extractURLPaths(c)) {
      sites.push({
        path: p,
        method: '',
        sourceQualifiedName: node.qualifiedName,
        sourceName: node.name,
        sourceLabel: 'Module',
        isAsync: false,
      });
    }
  }

  return sites;
}

// ─── Prefix resolution helpers ────────────────────────────────────────────────

/**
 * resolveFastAPIPrefixes prepends include_router prefixes to FastAPI routes.
 * Mutates routes in place, matching Python module QNs.
 */
export function resolveFastAPIPrefixes(
  routes: (RouteHandler & { handlerRef?: string })[],
  modules: NodeInfo[],
  rootPath: string,
): void {
  for (const mod of modules) {
    if (!mod.filePath.endsWith('.py')) continue;

    const src = readSourceFull(rootPath, mod.filePath);
    if (!src) continue;

    const includes = [...src.matchAll(new RegExp(fastAPIIncludeRe.source, 'g'))];
    if (includes.length === 0) continue;

    const imports = new Map<string, string>();
    for (const m of src.matchAll(new RegExp(pyImportRe.source, 'g'))) {
      imports.set(m[2], m[1]); // varName → module.path
    }

    for (const inc of includes) {
      const varName = inc[1];
      const prefix = inc[2];
      const modulePath = imports.get(varName);
      if (!modulePath) continue;

      const fileFrag = modulePath.replace(/\./g, '/');
      const normalizedPrefix = prefix.replace(/\/$/, '');

      for (const route of routes) {
        if (route.path.startsWith(normalizedPrefix)) continue;
        if (
          route.qualifiedName.includes(fileFrag + '.py') ||
          route.qualifiedName.includes(fileFrag + '/')
        ) {
          route.path = normalizedPrefix + '/' + route.path.replace(/^\//, '');
        }
      }
    }
  }
}

/**
 * resolveExpressPrefixes prepends app.use("/prefix", router) prefixes to Express routes.
 * Mutates routes in place, matching JS/TS module QNs.
 */
export function resolveExpressPrefixes(
  routes: (RouteHandler & { handlerRef?: string })[],
  modules: NodeInfo[],
  rootPath: string,
): void {
  for (const mod of modules) {
    if (!isJSTSFile(mod.filePath)) continue;

    const src = readSourceFull(rootPath, mod.filePath);
    if (!src) continue;

    const uses = [...src.matchAll(new RegExp(expressUseRe.source, 'g'))];
    if (uses.length === 0) continue;

    const imports = buildJSImportMap(src);

    for (const use of uses) {
      const prefix = use[1];
      const varName = use[2];
      const modulePath = imports.get(varName);
      if (!modulePath) continue;

      const fileFrag = modulePath.replace(/^\.\.?\/?/, '');
      const normalizedPrefix = prefix.replace(/\/$/, '');

      for (const route of routes) {
        if (route.path.startsWith(normalizedPrefix)) continue;
        if (
          route.qualifiedName.includes(fileFrag + '.js') ||
          route.qualifiedName.includes(fileFrag + '.ts') ||
          route.qualifiedName.includes(fileFrag + '/')
        ) {
          route.path = normalizedPrefix + '/' + route.path.replace(/^\//, '');
        }
      }
    }
  }
}

function isJSTSFile(filePath: string): boolean {
  return (
    filePath.endsWith('.js') || filePath.endsWith('.ts') ||
    filePath.endsWith('.mjs') || filePath.endsWith('.tsx')
  );
}

function buildJSImportMap(src: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const m of src.matchAll(new RegExp(jsRequireRe.source, 'g'))) {
    imports.set(m[1], m[2]);
  }
  for (const m of src.matchAll(new RegExp(jsImportRe.source, 'g'))) {
    imports.set(m[1], m[2]);
  }
  return imports;
}
