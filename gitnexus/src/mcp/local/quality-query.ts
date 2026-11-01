/**
 * `quality_query` presets: fixed, read-only Cypher over the indexed graph for
 * code-quality triage. Each preset returns one compact line per symbol.
 *
 * Edge model used (see `gitnexus-shared` REL_TYPES): CALLS, USES (value
 * references such as callbacks), ACCESSES, WRAPS, QUERIES, ADVISED_BY,
 * METHOD_OVERRIDES / METHOD_IMPLEMENTS, HANDLES_ROUTE / HANDLES_TOOL,
 * INJECTS (Spring/Kotlin collection injection only), Process.entryPointId.
 * `complexity` and `sloc` are columns on Function and Method rows.
 */
import { isTestFilePath } from '../../core/ingestion/utils/test-file-path.js';

export const QUALITY_PRESETS = [
  'high_complexity',
  'dead_code',
  'god_functions',
  'hotspots',
  'high_fan_out',
  'unused_injections',
] as const;
export type QualityPreset = (typeof QUALITY_PRESETS)[number];

export const QUALITY_DEFAULT_LIMIT = 20;
export const QUALITY_MAX_LIMIT = 500;

/** god_functions thresholds: long AND complex AND wide fan-out. */
export const GOD_MIN_SLOC = 50;
export const GOD_MIN_COMPLEXITY = 10;
export const GOD_MIN_FAN_OUT = 8;

export type QualityRows = Record<string, unknown>[];
export type QualityExecutor = (cypher: string, params: Record<string, unknown>) => Promise<QualityRows>;

export interface QualityQueryParams {
  preset?: unknown;
  limit?: unknown;
  path?: unknown;
}

export interface QualityItem {
  name: string;
  filePath: string;
  /** 1-based. */
  line: number;
  metric: string;
}

export interface QualityResult {
  preset: QualityPreset;
  count: number;
  /** One line per symbol: `name  file:line  metric`. */
  lines: string[];
  /** Present for candidate-style presets and when a preset cannot be answered. */
  note?: string;
}

const PATH_FILTER = '($path = "" OR n.filePath STARTS WITH $path)';
const CALLABLE = '(n:Function|Method)';
/** Page size when results are filtered in JS; bounded by MAX_PAGES. */
const PAGE = 500;
const MAX_PAGES = 40;

/** Incoming edge types that mean "something uses this symbol". */
const USAGE_EDGES = [
  'CALLS',
  'USES',
  'ACCESSES',
  'WRAPS',
  'QUERIES',
  'ADVISED_BY',
  'METHOD_OVERRIDES',
  'METHOD_IMPLEMENTS',
  'OVERRIDES',
];
/** Outgoing edge types that mean the framework invokes this symbol. */
const REGISTRATION_EDGES = [
  'HANDLES_ROUTE',
  'HANDLES_TOOL',
  'METHOD_OVERRIDES',
  'METHOD_IMPLEMENTS',
  'OVERRIDES',
];

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

const item = (row: Record<string, unknown>, metric: string): QualityItem => ({
  name: str(row.name),
  filePath: str(row.filePath),
  // Stored startLine is 0-based (tree-sitter rows).
  line: num(row.startLine) + 1,
  metric,
});

const formatLine = (i: QualityItem): string => `${i.name}  ${i.filePath}:${i.line}  ${i.metric}`;

const RETURN_SYMBOL = 'n.name AS name, n.filePath AS filePath, n.startLine AS startLine';

/** Constructors, dunders and framework-invoked names are never reported as dead. */
const isImplicitlyInvoked = (name: string): boolean =>
  name === 'constructor' ||
  name === 'main' ||
  name === 'init' ||
  name === '__init__' ||
  (name.startsWith('__') && name.endsWith('__')) ||
  /^(test|setUp|tearDown|beforeEach|afterEach|beforeAll|afterAll)/.test(name);

async function highComplexity(run: QualityExecutor, p: Resolved): Promise<QualityResult> {
  const rows = await run(
    `MATCH ${CALLABLE} WHERE n.complexity > 0 AND ${PATH_FILTER}
     RETURN ${RETURN_SYMBOL}, n.complexity AS complexity, n.sloc AS sloc
     ORDER BY complexity DESC, sloc DESC, name LIMIT $limit`,
    p,
  );
  const items = rows.map((r) => item(r, `cx=${num(r.complexity)} sloc=${num(r.sloc)}`));
  return { preset: 'high_complexity', count: items.length, lines: items.map(formatLine) };
}

async function godFunctions(run: QualityExecutor, p: Resolved): Promise<QualityResult> {
  const rows = await run(
    `MATCH ${CALLABLE}
     WHERE n.sloc >= $minSloc AND n.complexity >= $minComplexity AND ${PATH_FILTER}
     MATCH (n)-[r:CodeRelation {type: 'CALLS'}]->(t)
     WITH n, count(DISTINCT t.id) AS fanOut
     WHERE fanOut >= $minFanOut
     RETURN ${RETURN_SYMBOL}, n.complexity AS complexity, n.sloc AS sloc, fanOut
     ORDER BY complexity DESC, fanOut DESC, name LIMIT $limit`,
    { ...p, minSloc: GOD_MIN_SLOC, minComplexity: GOD_MIN_COMPLEXITY, minFanOut: GOD_MIN_FAN_OUT },
  );
  const items = rows.map((r) =>
    item(r, `cx=${num(r.complexity)} sloc=${num(r.sloc)} out=${num(r.fanOut)}`),
  );
  return {
    preset: 'god_functions',
    count: items.length,
    lines: items.map(formatLine),
    note: `sloc>=${GOD_MIN_SLOC}, cx>=${GOD_MIN_COMPLEXITY}, out>=${GOD_MIN_FAN_OUT}`,
  };
}

async function hotspots(run: QualityExecutor, p: Resolved): Promise<QualityResult> {
  const rows = await run(
    `MATCH (c)-[r:CodeRelation {type: 'CALLS'}]->${CALLABLE} WHERE ${PATH_FILTER}
     WITH n, count(DISTINCT c.id) AS callers
     RETURN ${RETURN_SYMBOL}, callers ORDER BY callers DESC, name LIMIT $limit`,
    p,
  );
  const items = rows.map((r) => item(r, `in=${num(r.callers)}`));
  return { preset: 'hotspots', count: items.length, lines: items.map(formatLine) };
}

async function highFanOut(run: QualityExecutor, p: Resolved): Promise<QualityResult> {
  const rows = await run(
    `MATCH ${CALLABLE}-[r:CodeRelation {type: 'CALLS'}]->(t) WHERE ${PATH_FILTER}
     WITH n, count(DISTINCT t.id) AS callees
     RETURN ${RETURN_SYMBOL}, callees ORDER BY callees DESC, name LIMIT $limit`,
    p,
  );
  const items = rows.map((r) => item(r, `out=${num(r.callees)}`));
  return { preset: 'high_fan_out', count: items.length, lines: items.map(formatLine) };
}

async function deadCode(run: QualityExecutor, p: Resolved): Promise<QualityResult> {
  const protectedIds = new Set<string>();
  const registered = await run(
    `MATCH (n)-[r:CodeRelation]->(m) WHERE r.type IN $registration RETURN DISTINCT n.id AS id`,
    { registration: REGISTRATION_EDGES },
  );
  for (const r of registered) protectedIds.add(str(r.id));
  const entries = await run(`MATCH (p:Process) RETURN DISTINCT p.entryPointId AS id`, {});
  for (const r of entries) protectedIds.add(str(r.id));

  const found: QualityItem[] = [];
  for (let page = 0; page < MAX_PAGES && found.length < p.limit; page++) {
    const rows = await run(
      `MATCH ${CALLABLE}
       WHERE n.isExported = false AND ${PATH_FILTER}
       OPTIONAL MATCH (u)-[r:CodeRelation]->(n) WHERE r.type IN $usage
       WITH n, count(r) AS uses WHERE uses = 0
       RETURN n.id AS id, ${RETURN_SYMBOL}
       ORDER BY filePath, startLine SKIP $skip LIMIT $page`,
      { ...p, usage: USAGE_EDGES, skip: page * PAGE, page: PAGE },
    );
    for (const r of rows) {
      const name = str(r.name);
      if (protectedIds.has(str(r.id)) || isImplicitlyInvoked(name)) continue;
      if (isTestFilePath(str(r.filePath))) continue;
      found.push(item(r, 'no-callers'));
      if (found.length >= p.limit) break;
    }
    if (rows.length < PAGE) break;
  }
  return {
    preset: 'dead_code',
    count: found.length,
    lines: found.map(formatLine),
    note: 'Candidates only: dynamic dispatch, reflection and decorators are invisible to the graph.',
  };
}

async function unusedInjections(run: QualityExecutor, p: Resolved): Promise<QualityResult> {
  const injected = await run(
    `MATCH (n:Class)-[i:CodeRelation {type: 'INJECTS'}]->(p) WHERE ${PATH_FILTER}
     RETURN n.id AS cid, ${RETURN_SYMBOL}, p.id AS pid, p.name AS provider
     ORDER BY filePath, startLine, provider`,
    p,
  );
  // A provider counts as used when a method of the consumer calls it, one of its
  // methods, or an interface method one of its methods implements.
  const usedQueries = [
    `MATCH (n:Class)-[:CodeRelation {type: 'INJECTS'}]->(p),
           (n)-[:CodeRelation {type: 'HAS_METHOD'}]->(m)-[:CodeRelation {type: 'CALLS'}]->(p)
     RETURN DISTINCT n.id AS cid, p.id AS pid`,
    `MATCH (n:Class)-[:CodeRelation {type: 'INJECTS'}]->(p),
           (p)-[:CodeRelation {type: 'HAS_METHOD'}]->(pm),
           (n)-[:CodeRelation {type: 'HAS_METHOD'}]->(m)-[:CodeRelation {type: 'CALLS'}]->(pm)
     RETURN DISTINCT n.id AS cid, p.id AS pid`,
    `MATCH (n:Class)-[:CodeRelation {type: 'INJECTS'}]->(p),
           (p)-[:CodeRelation {type: 'HAS_METHOD'}]->(pm)-[:CodeRelation {type: 'METHOD_IMPLEMENTS'}]->(im),
           (n)-[:CodeRelation {type: 'HAS_METHOD'}]->(m)-[:CodeRelation {type: 'CALLS'}]->(im)
     RETURN DISTINCT n.id AS cid, p.id AS pid`,
  ];
  const used = new Set<string>();
  for (const q of usedQueries) {
    for (const r of await run(q, {})) used.add(`${str(r.cid)}\0${str(r.pid)}`);
  }
  const items = injected
    .filter((r) => !used.has(`${str(r.cid)}\0${str(r.pid)}`))
    .slice(0, p.limit)
    .map((r) => item(r, `injects ${str(r.provider)}, never called`));
  return {
    preset: 'unused_injections',
    count: items.length,
    lines: items.map(formatLine),
    note: 'INJECTS covers Spring/Kotlin collection injection only; other DI styles are not modelled.',
  };
}

interface Resolved extends Record<string, unknown> {
  limit: number;
  path: string;
}

const HANDLERS: Record<QualityPreset, (run: QualityExecutor, p: Resolved) => Promise<QualityResult>> = {
  high_complexity: highComplexity,
  dead_code: deadCode,
  god_functions: godFunctions,
  hotspots,
  high_fan_out: highFanOut,
  unused_injections: unusedInjections,
};

/** Validate params and run one preset. Throws `Error` with a user-facing message. */
export async function runQualityQuery(
  run: QualityExecutor,
  params: QualityQueryParams,
): Promise<QualityResult> {
  const preset = params.preset;
  if (typeof preset !== 'string' || !(QUALITY_PRESETS as readonly string[]).includes(preset)) {
    throw new Error(`preset must be one of: ${QUALITY_PRESETS.join(', ')}`);
  }
  let limit = QUALITY_DEFAULT_LIMIT;
  if (params.limit !== undefined) {
    if (typeof params.limit !== 'number' || !Number.isInteger(params.limit) || params.limit < 1) {
      throw new Error('limit must be a positive integer');
    }
    limit = Math.min(params.limit, QUALITY_MAX_LIMIT);
  }
  if (params.path !== undefined && typeof params.path !== 'string') {
    throw new Error('path must be a string prefix');
  }
  const pathPrefix = (params.path ?? '').toString().replace(/\\/g, '/').replace(/^\.\//, '');
  return HANDLERS[preset as QualityPreset](run, { limit, path: pathPrefix });
}

export function formatQualityResult(result: QualityResult): string {
  const head = `${result.preset}: ${result.count} result${result.count === 1 ? '' : 's'}${
    result.note ? ` (${result.note})` : ''
  }`;
  return [head, ...result.lines].join('\n');
}
