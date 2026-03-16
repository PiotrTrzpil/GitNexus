/**
 * Semantic Edge Processor
 *
 * Post-parse resolution of semantic edges:
 * - READS_FIELD / WRITES_FIELD: function/method → property (field access edges)
 * - USES_TYPE: function/method/parameter → class/interface/type (type reference edges)
 * - THROWS: function/method → class (exception type thrown edges)
 *
 * Extracted in the parse worker (as AST facts), resolved here in the main thread
 * against the symbol table using the same tiered confidence model as CALLS edges.
 *
 * Runs as the 'semantic-edges' pipeline phase after MRO resolution and before
 * community detection.
 */

import type { KnowledgeGraph } from '../graph/types.js';
import type { ResolutionContext } from './resolution-context.js';
import { TIER_CONFIDENCE } from './resolution-context.js';
import { generateId } from '../../lib/utils.js';
import { yieldToEventLoop } from './utils.js';

// ── Local interface definitions ─────────────────────────────────────────────
// These mirror the types defined in parse-worker.ts (added by another agent).
// When parse-worker.ts exports them, re-import from there; keep locals as
// structural fallback until integration.

export interface ExtractedFieldAccess {
  filePath: string;
  /** generateId of the accessing function/method */
  sourceId: string;
  /** Name of the accessed field/property */
  fieldName: string;
  /** Name of the receiver (e.g., 'user' in user.name) */
  receiverName: string;
  /** Resolved type of the receiver (e.g., 'User') — filled by type env in parse worker */
  receiverType?: string;
  /** 'read' | 'write' */
  accessKind: 'read' | 'write';
}

export interface ExtractedTypeUsage {
  filePath: string;
  /** generateId of the source function/method/parameter node */
  sourceId: string;
  /** Name of the referenced type */
  typeName: string;
  /** 'param' | 'return' | 'generic' | 'cast' */
  usageKind: string;
}

export interface ExtractedThrow {
  filePath: string;
  /** generateId of the throwing function/method */
  sourceId: string;
  /** Constructor name from `throw new ExceptionType(...)` */
  exceptionName: string;
}

// ── Built-in / noise type filter ─────────────────────────────────────────────
// Same exclusion list as codebase-memory-mcp. Types in this set do not produce
// USES_TYPE edges because they carry no semantic graph value.

const BUILTIN_TYPES = new Set([
  // Primitives
  'string', 'number', 'boolean', 'void', 'any', 'unknown', 'never',
  'null', 'undefined', 'object', 'symbol', 'bigint',
  // TS utility types
  'Promise', 'Array', 'Map', 'Set', 'Record', 'Partial', 'Required',
  'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable',
  'ReturnType', 'InstanceType', 'Parameters', 'ConstructorParameters',
  'Awaited', 'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize',
  // JS built-ins that appear in type position
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'EvalError', 'URIError', 'AggregateError',
  'Date', 'RegExp', 'Function', 'Object',
  'WeakMap', 'WeakSet', 'WeakRef',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'SharedArrayBuffer',
  'DataView', 'Blob', 'URL', 'URLSearchParams', 'FormData', 'Headers',
  'Request', 'Response', 'Event', 'EventTarget', 'AbortController',
  'AbortSignal', 'ReadableStream', 'WritableStream', 'TransformStream',
  // Node.js built-ins
  'Buffer', 'Stream', 'Readable', 'Writable', 'Duplex', 'Transform',
  'EventEmitter', 'ChildProcess', 'Worker',
  // Common framework types that are too generic to be meaningful
  'T', 'K', 'V', 'E', 'U', 'R',  // single-letter generic params
]);

const isBuiltinType = (typeName: string): boolean => {
  if (BUILTIN_TYPES.has(typeName)) return true;
  // Skip single-character generics
  if (typeName.length === 1) return true;
  // Skip types that start with lowercase (likely primitives or generic params)
  if (/^[a-z]/.test(typeName)) return true;
  return false;
};

// ── Resolution helpers ────────────────────────────────────────────────────────

interface ResolveResult {
  nodeId: string;
  confidence: number;
  reason: string;
}

const CLASS_LIKE_TYPES = new Set(['Class', 'Interface', 'Type', 'TypeAlias', 'Struct', 'Enum', 'Trait', 'Record']);
const PROPERTY_LIKE_TYPES = new Set(['Property', 'Field', 'Variable']);

/**
 * Resolve a type name (class/interface/type) to its graph node ID.
 * Uses tiered resolution: same-file → import-scoped → global (single candidate only).
 */
const resolveTypeName = (
  typeName: string,
  fromFile: string,
  ctx: ResolutionContext,
): ResolveResult | null => {
  const tiered = ctx.resolve(typeName, fromFile);
  if (!tiered) return null;

  // Filter to class-like symbols
  const candidates = tiered.candidates.filter(d => CLASS_LIKE_TYPES.has(d.type));
  if (candidates.length === 0) return null;

  // Refuse ambiguous global resolution
  if (tiered.tier === 'global' && candidates.length > 1) return null;

  const def = candidates[0];
  const confidence = TIER_CONFIDENCE[tiered.tier];
  const reason = tiered.tier === 'same-file'
    ? 'same-file'
    : tiered.tier === 'import-scoped'
    ? 'import-resolved'
    : 'global';

  return { nodeId: def.nodeId, confidence, reason };
};

/**
 * Resolve a property/field name owned by a specific class node.
 *
 * Strategy:
 * 1. Look up `fieldName` in the symbol table — filter to Property/Field types.
 * 2. Narrow by ownerId matching the receiver class node ID.
 * 3. Return confidence based on how the receiver was resolved:
 *    - 1.0 if receiver was `this`/`self` (same class) → reason: 'self-access'
 *    - 1.0 if receiver type is annotation-derived
 *    - 0.7 if receiver type was inferred from constructor binding
 *    - 0.4 if no receiver type (name-only fallback match)
 */
const resolveFieldAccess = (
  access: ExtractedFieldAccess,
  ctx: ResolutionContext,
): { nodeId: string; confidence: number; reason: string; edgeType: 'READS_FIELD' | 'WRITES_FIELD' } | null => {
  const edgeType = access.accessKind === 'write' ? 'WRITES_FIELD' : 'READS_FIELD';

  // ── Resolve the receiver type to a class node ────────────────────────────
  const isSelfAccess = access.receiverName === 'this' || access.receiverName === 'self' || access.receiverName === '$this';

  let receiverClassNodeId: string | undefined;
  let baseConfidence: number;
  let baseReason: string;

  if (access.receiverType) {
    // Receiver type is known (either set by parse worker for `this` accesses, or
    // from explicit type annotation on a cross-class receiver).
    const classResolved = ctx.resolve(access.receiverType, access.filePath);
    if (!classResolved || classResolved.candidates.length === 0) return null;

    // Refuse global ambiguity
    if (classResolved.tier === 'global' && classResolved.candidates.length > 1) return null;

    receiverClassNodeId = classResolved.candidates[0].nodeId;
    // Self-access always gets confidence 1.0 regardless of resolution tier,
    // because `this` is authoritative — the type is known from the enclosing class.
    baseConfidence = isSelfAccess ? 1.0 : TIER_CONFIDENCE[classResolved.tier];
    baseReason = isSelfAccess ? 'self-access' : classResolved.tier === 'same-file' ? 'same-file' : 'import-resolved';
  } else if (isSelfAccess) {
    // `this.field` but parse worker did not populate receiverType.
    // Cannot resolve without knowing the enclosing class — skip.
    // The parse worker is expected to fill receiverType for all `this` accesses
    // via buildTypeEnv. If it doesn't, we fall through to name-only resolution.
    baseConfidence = 0.7; // inferred: we know it's a self-access but can't confirm class
    baseReason = 'self-access';
    // receiverClassNodeId remains undefined — field narrowing by name only below
  } else {
    // No receiver type — heuristic name-only match (low confidence)
    baseConfidence = 0.4;
    baseReason = 'name-only';
  }

  // ── Resolve the field name ────────────────────────────────────────────────
  const allFieldDefs = ctx.symbols.lookupFuzzy(access.fieldName);
  const propertyDefs = allFieldDefs.filter(d => PROPERTY_LIKE_TYPES.has(d.type));

  if (propertyDefs.length === 0) return null;

  let targetDef = propertyDefs.length === 1 ? propertyDefs[0] : undefined;

  if (!targetDef && receiverClassNodeId) {
    // Narrow by ownerId (Property → owning class)
    const ownerFiltered = propertyDefs.filter(d => d.ownerId === receiverClassNodeId);
    if (ownerFiltered.length === 1) {
      targetDef = ownerFiltered[0];
    } else if (ownerFiltered.length > 1) {
      // Multiple properties with same name in class — shouldn't happen, take first
      targetDef = ownerFiltered[0];
    }
  }

  if (!targetDef && !receiverClassNodeId) {
    // Absolute fallback: single candidate globally
    if (propertyDefs.length !== 1) return null;
    targetDef = propertyDefs[0];
  }

  if (!targetDef) return null;

  return { nodeId: targetDef.nodeId, confidence: baseConfidence, reason: baseReason, edgeType };
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Resolve pre-extracted semantic edges from parse workers into graph edges.
 *
 * Processes:
 * 1. READS_FIELD / WRITES_FIELD from field accesses
 * 2. USES_TYPE from type usages (deduplicated per source→target pair)
 * 3. THROWS from throw statements
 *
 * Follows the same chunked async pattern as processCallsFromExtracted to avoid
 * blocking the event loop on large codebases.
 */
export const processSemanticEdges = async (
  graph: KnowledgeGraph,
  fieldAccesses: ExtractedFieldAccess[],
  typeUsages: ExtractedTypeUsage[],
  throws: ExtractedThrow[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
): Promise<void> => {
  const total = fieldAccesses.length + typeUsages.length + throws.length;
  let processed = 0;

  // ── 1. READS_FIELD / WRITES_FIELD ─────────────────────────────────────────
  // Group by file for cache efficiency (ctx.enableCache is per-file)
  const fieldsByFile = new Map<string, ExtractedFieldAccess[]>();
  for (const access of fieldAccesses) {
    let list = fieldsByFile.get(access.filePath);
    if (!list) { list = []; fieldsByFile.set(access.filePath, list); }
    list.push(access);
  }

  for (const [filePath, accesses] of fieldsByFile) {
    ctx.enableCache(filePath);

    for (const access of accesses) {
      const resolved = resolveFieldAccess(access, ctx);
      if (!resolved) {
        processed++;
        continue;
      }

      const relId = generateId(resolved.edgeType, `${access.sourceId}->${resolved.nodeId}`);
      graph.addRelationship({
        id: relId,
        sourceId: access.sourceId,
        targetId: resolved.nodeId,
        type: resolved.edgeType,
        confidence: resolved.confidence,
        reason: resolved.reason,
      });

      processed++;
      if (processed % 500 === 0) {
        onProgress?.(processed, total);
        await yieldToEventLoop();
      }
    }

    ctx.clearCache();
  }

  // ── 2. USES_TYPE ──────────────────────────────────────────────────────────
  // Deduplicate per (sourceId, targetNodeId) pair — a function using `User` in
  // both param and return type gets exactly one USES_TYPE edge.
  const seenUsesType = new Set<string>();

  const usagesByFile = new Map<string, ExtractedTypeUsage[]>();
  for (const usage of typeUsages) {
    let list = usagesByFile.get(usage.filePath);
    if (!list) { list = []; usagesByFile.set(usage.filePath, list); }
    list.push(usage);
  }

  for (const [filePath, usages] of usagesByFile) {
    ctx.enableCache(filePath);

    for (const usage of usages) {
      if (isBuiltinType(usage.typeName)) {
        processed++;
        continue;
      }

      const resolved = resolveTypeName(usage.typeName, filePath, ctx);
      if (!resolved) {
        processed++;
        continue;
      }

      const dedupeKey = `${usage.sourceId}→${resolved.nodeId}`;
      if (seenUsesType.has(dedupeKey)) {
        processed++;
        continue;
      }
      seenUsesType.add(dedupeKey);

      const relId = generateId('USES_TYPE', `${usage.sourceId}->${resolved.nodeId}`);
      graph.addRelationship({
        id: relId,
        sourceId: usage.sourceId,
        targetId: resolved.nodeId,
        type: 'USES_TYPE',
        confidence: resolved.confidence,
        reason: resolved.reason,
      });

      processed++;
      if (processed % 500 === 0) {
        onProgress?.(processed, total);
        await yieldToEventLoop();
      }
    }

    ctx.clearCache();
  }

  // ── 3. THROWS ─────────────────────────────────────────────────────────────
  const throwsByFile = new Map<string, ExtractedThrow[]>();
  for (const thrown of throws) {
    let list = throwsByFile.get(thrown.filePath);
    if (!list) { list = []; throwsByFile.set(thrown.filePath, list); }
    list.push(thrown);
  }

  for (const [filePath, fileThrows] of throwsByFile) {
    ctx.enableCache(filePath);

    for (const thrown of fileThrows) {
      const tiered = ctx.resolve(thrown.exceptionName, filePath);
      if (!tiered) {
        processed++;
        continue;
      }

      // Exception types must be classes (or class-like)
      const candidates = tiered.candidates.filter(d => CLASS_LIKE_TYPES.has(d.type));
      if (candidates.length === 0) {
        processed++;
        continue;
      }

      // Refuse global ambiguity
      if (tiered.tier === 'global' && candidates.length > 1) {
        processed++;
        continue;
      }

      const def = candidates[0];
      const confidence = TIER_CONFIDENCE[tiered.tier];
      const reason = tiered.tier === 'same-file'
        ? 'same-file'
        : tiered.tier === 'import-scoped'
        ? 'import-resolved'
        : 'global';

      const relId = generateId('THROWS', `${thrown.sourceId}->${def.nodeId}`);
      graph.addRelationship({
        id: relId,
        sourceId: thrown.sourceId,
        targetId: def.nodeId,
        type: 'THROWS',
        confidence,
        reason,
      });

      processed++;
      if (processed % 500 === 0) {
        onProgress?.(processed, total);
        await yieldToEventLoop();
      }
    }

    ctx.clearCache();
  }

  onProgress?.(total, total);
};

/**
 * Resolve Parameter nodes' USES_TYPE edges.
 *
 * Parameter nodes are created by the parse worker (another agent), but their
 * USES_TYPE edges to resolved type nodes are emitted here, in the same phase
 * as other semantic edges. This keeps all type resolution in one place.
 *
 * The parse worker emits ExtractedTypeUsage entries with usageKind='param' for
 * each parameter annotation — they are processed by processSemanticEdges above.
 * This function is a dedicated entry point for any remaining Parameter→Type
 * edges that could not be bundled into the main typeUsages array.
 *
 * In practice, callers should pass parameter type usages directly into
 * processSemanticEdges via the `typeUsages` array; this function exists as
 * an explicit seam for integration.
 */
export const processParameterTypeEdges = async (
  graph: KnowledgeGraph,
  paramTypeUsages: ExtractedTypeUsage[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
): Promise<void> => {
  // Delegate to main processor — parameters are indistinguishable from other
  // USES_TYPE sources at resolution time.
  await processSemanticEdges(graph, [], paramTypeUsages, [], ctx, onProgress);
};
