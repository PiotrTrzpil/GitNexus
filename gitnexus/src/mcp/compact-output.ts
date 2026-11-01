/**
 * Compact text rendering of `impact` and `context` results for agent boundaries.
 *
 * An agent re-reads every tool output on each later turn. The structured
 * results repeat each symbol's file inside its uid, name and kind on separate
 * lines, and list every flow as an object. The compact view groups symbols by
 * file under each depth (impact) or relation and direction (context), derives
 * the class-qualified name from the uid, and caps the long flow/module lists.
 *
 * Renderers run only at the MCP server and CLI boundaries, AFTER
 * `shapeImpactForAgent`, so pagination and budget trimming have already been
 * applied. They return `null` for anything they do not recognise (errors,
 * ambiguous or not-found results, PDG mode, group fan-out), and the caller then
 * falls back to the structured result. Fields the renderer has no dedicated
 * format for are appended as `key: <json>` rather than dropped.
 */

/** Longest flow / module / route list shown before "(+N more)". */
export const COMPACT_LIST_CAP = 10;
/** Edges below this confidence are marked with `?`. */
export const COMPACT_LOW_CONFIDENCE = 0.8;

type Rec = Record<string, any>;

const isRecord = (value: unknown): value is Rec =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

interface SymbolRef {
  uid?: string;
  id?: string;
  name?: string;
  filePath?: string;
  relationType?: string;
  confidence?: number;
  staticGated?: boolean;
  processes?: unknown[];
  processCount?: number;
  routes?: Array<{ url: string; method?: string }>;
}

/** `Method:src/x.ts:Foo.bar` with file `src/x.ts` gives `Foo.bar`; falls back to `name`. */
function qualifiedName(ref: SymbolRef, file: string): string {
  const uid = ref.uid ?? ref.id ?? '';
  const marker = `:${file}:`;
  const at = file ? uid.indexOf(marker) : -1;
  if (at >= 0 && uid.length > at + marker.length) return uid.slice(at + marker.length);
  return ref.name ?? uid;
}

function edgeTag(relationType: string | undefined): string {
  if (!relationType || relationType === 'CALLS') return '';
  return ` [${relationType.toLowerCase()}]`;
}

function renderRef(ref: SymbolRef, file: string): string {
  let text = qualifiedName(ref, file) + edgeTag(ref.relationType);
  if (typeof ref.confidence === 'number' && ref.confidence < COMPACT_LOW_CONFIDENCE) text += '?';
  if (ref.staticGated === true) text += ' [gated]';
  const flows = ref.processCount ?? (Array.isArray(ref.processes) ? ref.processes.length : 0);
  if (flows > 0) text += `#${flows}f`;
  if (Array.isArray(ref.routes) && ref.routes.length > 0) {
    text += ` @${ref.routes.map((r) => (r.method ? `${r.method} ${r.url}` : r.url)).join(',')}`;
  }
  return text;
}

/** One line per file, files in first-seen order. */
function renderFileGroups(refs: SymbolRef[], indent = '  '): string[] {
  const groups = new Map<string, SymbolRef[]>();
  for (const ref of refs) {
    const file = ref.filePath ?? '';
    const list = groups.get(file);
    if (list) list.push(ref);
    else groups.set(file, [ref]);
  }
  return [...groups].map(
    ([file, list]) => `${indent}${file}: ${list.map((ref) => renderRef(ref, file)).join(', ')}`,
  );
}

function capped(items: string[]): string {
  return items.length > COMPACT_LIST_CAP
    ? `${items.slice(0, COMPACT_LIST_CAP).join(', ')} (+${items.length - COMPACT_LIST_CAP} more)`
    : items.join(', ');
}

/** Fields without a dedicated format are kept, as one JSON line each. */
function extraLines(source: Rec, handled: ReadonlySet<string>): string[] {
  return Object.keys(source)
    .filter((key) => !handled.has(key) && source[key] !== undefined)
    .map((key) => `${key}: ${JSON.stringify(source[key])}`);
}

const sortedDepths = (byDepth: Rec): string[] =>
  Object.keys(byDepth).sort((a, b) => Number(a) - Number(b));

const IMPACT_HANDLED: ReadonlySet<string> = new Set([
  'target',
  'direction',
  'impactedCount',
  'risk',
  'summary',
  'byDepthCounts',
  'byDepth',
  'affected_processes',
  'affected_modules',
  'affected_routes',
  'co_changed',
  'pagination',
]);

export function compactImpact(result: unknown): string | null {
  if (!isRecord(result) || 'error' in result || result.mode === 'pdg') return null;
  const { target } = result;
  if (!isRecord(target) || typeof target.name !== 'string') return null;
  const byDepth = result.byDepth;
  const counts = isRecord(result.byDepthCounts) ? result.byDepthCounts : {};
  if (byDepth !== undefined && !isRecord(byDepth)) return null;
  if (byDepth === undefined && !isRecord(result.byDepthCounts)) return null;

  const summary = isRecord(result.summary) ? result.summary : {};
  const type = typeof target.type === 'string' && target.type ? ` (${target.type})` : '';
  const lines: string[] = [
    `${target.name}${type}  ${target.filePath ?? ''}  ${result.direction ?? ''} · ` +
      `${result.impactedCount ?? 0} impacted · risk ${result.risk ?? 'UNKNOWN'}` +
      ` (${summary.processes_affected ?? 0} flows, ${summary.modules_affected ?? 0} modules)`,
  ];

  if (byDepth) {
    let anyFlows = false;
    for (const depth of sortedDepths(byDepth)) {
      const items: SymbolRef[] = Array.isArray(byDepth[depth]) ? byDepth[depth] : [];
      anyFlows ||= items.some(
        (i) => i.processCount !== undefined || (i.processes?.length ?? 0) > 0,
      );
      const total = typeof counts[depth] === 'number' ? counts[depth] : items.length;
      lines.push(
        total > items.length
          ? `depth ${depth} (showing ${items.length} of ${total}):`
          : `depth ${depth} (${items.length}):`,
      );
      lines.push(...renderFileGroups(items));
    }
    if (anyFlows) lines.push('(#Nf = flows through the symbol)');
  } else {
    // summaryOnly: counts without the symbol list.
    lines.push(
      `depths: ${sortedDepths(counts)
        .map((d) => `${d}=${counts[d]}`)
        .join(' ')} (symbols omitted)`,
    );
  }

  const pagination = result.pagination;
  if (isRecord(pagination)) {
    const parts: string[] = [];
    if (pagination.limit !== undefined) parts.push(`limit ${pagination.limit}`);
    if (pagination.offset !== undefined) parts.push(`offset ${pagination.offset}`);
    if (pagination.truncated) parts.push('truncated');
    const budget = pagination.trimmedForBudget;
    if (isRecord(budget)) {
      parts.push(
        `trimmed for maxTokens ${budget.maxTokens}, shown per depth ${JSON.stringify(budget.shownByDepth)}`,
      );
    }
    const known = new Set(['limit', 'offset', 'truncated', 'trimmedForBudget']);
    for (const line of extraLines(pagination, known)) parts.push(line);
    lines.push(`pagination: ${parts.join(', ')}`);
  }

  const flows: Rec[] = Array.isArray(result.affected_processes) ? result.affected_processes : [];
  if (flows.length > 0) {
    lines.push(
      `flows (${flows.length}): ${capped(
        flows.map((f) => (f.total_hits > 1 ? `${f.name}×${f.total_hits}` : String(f.name))),
      )}`,
    );
  }
  const modules: Rec[] = Array.isArray(result.affected_modules) ? result.affected_modules : [];
  if (modules.length > 0) {
    lines.push(
      `modules (${modules.length}): ${capped(
        modules.map((m) => `${m.name}(${m.hits ?? 0}${m.impact === 'direct' ? ',direct' : ''})`),
      )}`,
    );
  }
  const routes: Rec[] = Array.isArray(result.affected_routes) ? result.affected_routes : [];
  if (routes.length > 0) {
    lines.push(
      `routes (${routes.length}): ${capped(routes.map((r) => (r.method ? `${r.method} ${r.url}` : r.url)))}`,
    );
  }

  const coChanged: Rec[] = Array.isArray(result.co_changed) ? result.co_changed : [];
  if (coChanged.length > 0) {
    lines.push(
      `usually changes with: ${capped(coChanged.map((c) => `${c.file} (${c.strength})`))}`,
    );
  }

  lines.push(...extraLines(result, IMPACT_HANDLED));
  return lines.join('\n');
}

const CONTEXT_HANDLED: ReadonlySet<string> = new Set([
  'status',
  'symbol',
  'incoming',
  'outgoing',
  'processes',
  'chain',
  'routes',
  'typed_properties',
  'is_entry_point',
]);

const SYMBOL_HANDLED: ReadonlySet<string> = new Set([
  'uid',
  'name',
  'kind',
  'filePath',
  'startLine',
  'endLine',
  'content',
]);

export function compactContext(result: unknown): string | null {
  if (!isRecord(result) || 'error' in result || result.status !== 'found') return null;
  const { symbol } = result;
  if (!isRecord(symbol) || typeof symbol.name !== 'string') return null;

  const lines: string[] = [
    `${symbol.name}  ${symbol.kind ?? ''}  ${symbol.filePath ?? ''}:${symbol.startLine}-${symbol.endLine}` +
      (result.is_entry_point ? '  entry-point' : ''),
  ];
  lines.push(...extraLines(symbol, SYMBOL_HANDLED));

  for (const [direction, byType] of [
    ['in', result.incoming],
    ['out', result.outgoing],
  ] as const) {
    if (!isRecord(byType)) continue;
    for (const [relType, entries] of Object.entries(byType)) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      lines.push(`${direction} ${relType} (${entries.length}):`);
      lines.push(...renderFileGroups(entries));
    }
  }

  if (Array.isArray(result.typed_properties) && result.typed_properties.length > 0) {
    lines.push(
      `properties (${result.typed_properties.length}): ${capped(
        result.typed_properties.map((p: Rec) => `${p.name}: ${p.declaredType ?? '?'}`),
      )}`,
    );
  }
  if (Array.isArray(result.routes) && result.routes.length > 0) {
    lines.push(
      `routes: ${result.routes.map((r: Rec) => (r.method ? `${r.method} ${r.url}` : r.url)).join(', ')}`,
    );
  }
  if (Array.isArray(result.chain)) {
    for (const layer of result.chain as Rec[]) {
      for (const [arrow, nodes] of [
        ['callers', layer.upstream],
        ['callees', layer.downstream],
      ] as const) {
        if (!Array.isArray(nodes) || nodes.length === 0) continue;
        lines.push(`chain ${layer.depth} ${arrow} (${nodes.length}):`);
        lines.push(...renderFileGroups(nodes));
      }
    }
  }
  const flows: Rec[] = Array.isArray(result.processes) ? result.processes : [];
  if (flows.length > 0) {
    lines.push(
      `flows (${flows.length}): ${capped(flows.map((f) => `${f.name} ${f.step_index}/${f.step_count}`))}`,
    );
  }
  lines.push(...extraLines(result, CONTEXT_HANDLED));
  if (typeof symbol.content === 'string' && symbol.content) lines.push('', symbol.content);
  return lines.join('\n');
}

/**
 * Compact text for tools that have a compact view; `null` for every other tool
 * and for results the renderers do not recognise.
 */
export function compactToolResult(toolName: string, result: unknown): string | null {
  if (toolName === 'impact') return compactImpact(result);
  if (toolName === 'context') return compactContext(result);
  return null;
}

/** Drops the `verbose` flag so it never reaches the backend. */
export function withoutMcpVerboseArg(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!args || !Object.prototype.hasOwnProperty.call(args, 'verbose')) return args;
  const backendArgs = { ...args };
  delete backendArgs.verbose;
  return backendArgs;
}
