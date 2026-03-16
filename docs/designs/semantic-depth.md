# Semantic Depth — Design

## Overview

Add sub-function granularity to GitNexus so that LLM agents and Cypher queries can answer semantic code quality questions — encapsulation violations, dependency injection patterns, parameter optionality, complexity hotspots, field access patterns — without reading source code. Also enrich CALLS edges with conditional-call metadata so that consumers tracing a call chain during refactoring can distinguish always-executed calls from conditional/guarded ones. This closes the gap with codebase-memory-mcp's READS/WRITES/USAGE/USES_TYPE/THROWS edges, complexity metric, and layer classification, while going further with visibility modifiers, parameter-level detail, accessor detection, and call-site conditionality that neither tool has today.

## Current State

- **What exists**: Nodes are Functions/Methods/Classes with `parameterCount`, `returnType`, `isExported`. Edges are CALLS, IMPORTS, INHERITS, IMPLEMENTS, OVERRIDES, DEFINES, HAS_METHOD, USES, DECORATES. No sub-function detail.
- **What stays**: All existing node types, edge types, pipeline phases, and MCP tools. This is purely additive.
- **What changes**: `NodeProperties` gains new optional fields. `RelationshipType` gains new edge types. Parse worker extracts more data. New pipeline phase for semantic edges. New MCP tool for quality queries.

## Summary for Review

- **Interpretation**: Make the graph rich enough that an external consumer (LLM, script, Cypher query) can answer questions like "does class A access private fields of class B?", "which constructor params are used only once?", "which functions have >5 optional params?", "which methods have high cyclomatic complexity?", and "when I refactor function X, which calls in the chain are always-executed vs conditionally-guarded?" — without the tool itself flagging these. The tool provides the primitives; the consumer writes the queries.
- **Key decisions**:
  - Parameters become **first-class `Parameter` nodes** with `PARAM_OF` edges to their parent function/method and `USES_TYPE` edges to their type. This enables direct graph traversal for DI analysis, type coupling queries, and cross-function param tracing. Cost is ~3x node count increase on a typical project (~6k nodes for 50k LOC) — negligible for an in-memory graph.
  - Fields/properties get **visibility as a node property** rather than a separate edge — simpler to query.
  - New edge types (`READS_FIELD`, `WRITES_FIELD`, `USES_TYPE`, `THROWS`) follow codebase-memory-mcp's proven model but adapted to GitNexus's confidence-scored edge system.
  - Complexity is a **node property** computed during parsing (same approach as codebase-memory-mcp's C-level branching count, but in the JS parse worker).
  - Layer classification is a **post-hoc computation** in the MCP tool, not stored in the graph — it depends on the full graph state and would go stale.
  - CALLS edges gain **`isConditional` and `guardExpression`** properties — extracted by checking if the call_expression is nested inside an `if_statement`, `ternary_expression`, `switch_case`, `catch_clause`, or short-circuit `&&`/`||`/`??`. This lets consumers following a call chain distinguish the hot path from error/feature-flag/edge-case branches without reading source.
- **Assumptions**: TypeScript/JavaScript are the priority languages; other languages get complexity + USES_TYPE but not full visibility/accessor extraction initially. PR #310 (type resolution phase 4) will merge first and this builds on it.
- **Scope**: Extraction + storage + queryability. No built-in smell detection, no UI changes, no new CLI commands. Consumers write their own queries.

## Conventions

- Pipeline phases are string literals in `PipelinePhase` union type (`types/pipeline.ts`)
- Node properties are optional fields on `NodeProperties` (flat object, no nesting beyond `string[]`)
- Edge types are string literals in `RelationshipType` union
- Parse worker results are serializable (no Maps/functions) — transferred via `postMessage`
- Type extractors follow `LanguageTypeConfig` interface pattern per language
- Tree-sitter queries in `LANGUAGE_QUERIES` object keyed by `SupportedLanguages`
- All new extraction happens in the parse worker for parallelism; post-parse resolution in main thread
- Confidence scores: 1.0 for AST-derived facts, 0.8+ for type-inferred, <0.8 for heuristic

## Architecture

### Subsystems

| # | Subsystem | Responsibility | Depends On | Files |
|---|-----------|---------------|------------|-------|
| 1 | Schema Extension | New node properties, edge types, extracted data types | — | `types.ts`, `parse-worker.ts` types |
| 2 | Complexity Extraction | Cyclomatic complexity per function/method during parse | 1 | parse worker, new `complexity.ts` helper |
| 3 | Visibility & Accessor Extraction | `visibility`, `isAccessor`, `isReadonly` on Property/Method/Field nodes | 1 | parse worker, TS/JS-specific AST logic |
| 4 | Parameter Detail Extraction | Structured parameter metadata (name, type, optional, default) per function/method | 1 | parse worker, type extractor enhancement |
| 5 | Semantic Edge Phase | READS_FIELD, WRITES_FIELD, USES_TYPE, THROWS edges resolved post-parse | 1, 3, 4 | new `semantic-edge-processor.ts` |
| 6 | Call Conditionality | `isConditional`, `guardExpression` metadata on CALLS edges | 1 | parse worker enhancement |
| 7 | Layer & Quality MCP Tool | `quality_query` tool exposing pre-built Cypher templates for common questions | 1-6 | `tools.ts` addition |

## Shared Contracts

```typescript
// ── Schema additions (types.ts) ──────────────────────────────────────────

// Add to NodeProperties:
interface NodeProperties {
  // ... existing fields ...

  /** Cyclomatic complexity (branching node count). Functions/Methods only. */
  complexity?: number;
  /** Source lines of code (endLine - startLine + 1). */
  sloc?: number;
  /** Visibility modifier: 'public' | 'protected' | 'private'. Class members only. */
  visibility?: 'public' | 'protected' | 'private';
  /** True for get/set accessors (as opposed to regular methods/properties). */
  isAccessor?: boolean;
  /** True for readonly/const fields. */
  isReadonly?: boolean;
  /** True for static members. */
  isStatic?: boolean;
  /** True for abstract methods/classes. */
  isAbstract?: boolean;
  // ── Parameter node properties (label: 'Parameter') ──
  /** Ordinal position in the parameter list (0-indexed). Parameter nodes only. */
  ordinal?: number;
  /** True if the parameter has `?` or a default value. Parameter nodes only. */
  isOptional?: boolean;
  /** True if the parameter has `= defaultValue`. Parameter nodes only. */
  hasDefault?: boolean;
  /** True if the parameter is a rest/spread param (`...args`). Parameter nodes only. */
  isRest?: boolean;
}

// Add 'Parameter' to NodeLabel union:
type NodeLabel = /* ...existing... */ | 'Parameter';

// Add to RelationshipType:
type RelationshipType =
  | /* ...existing... */
  | 'PARAM_OF'         // Parameter → Function/Method/Constructor (parameter belongs to)
  | 'READS_FIELD'      // Function/Method → Property (cross-class field read)
  | 'WRITES_FIELD'     // Function/Method → Property (cross-class field write)
  | 'USES_TYPE'        // Function/Method/Parameter → Class/Interface/Type (type reference)
  | 'THROWS'           // Function/Method → Class (exception type thrown)

// Add to GraphRelationship (optional properties for CALLS edges):
interface GraphRelationship {
  // ... existing fields (id, sourceId, targetId, type, confidence, reason, step) ...

  /** True when the call site is inside a branching construct (if/switch/ternary/catch/&&/||/??). CALLS edges only. */
  isConditional?: boolean;
  /**
   * Short summary of the guard expression (e.g., "if (user.isAdmin)", "catch", "x && ...").
   * Truncated to 120 chars. Omitted when isConditional is false or the call is unconditional.
   */
  guardExpression?: string;
  /**
   * Nesting depth of branching constructs around the call site.
   * 0 = unconditional, 1 = inside one if/switch, 2 = nested if-inside-if, etc.
   * Useful for distinguishing "lightly guarded" from "deeply nested edge-case" calls.
   */
  branchDepth?: number;
}

// ── Parse worker extracted data additions ────────────────────────────────

interface ExtractedFieldAccess {
  filePath: string;
  /** QN or generateId of the accessing function */
  sourceId: string;
  /** Name of the accessed field/property */
  fieldName: string;
  /** Name of the receiver (e.g., 'user' in user.name) */
  receiverName: string;
  /** Resolved type of the receiver (e.g., 'User') — filled by type env */
  receiverType?: string;
  /** 'read' | 'write' */
  accessKind: 'read' | 'write';
}

interface ExtractedTypeUsage {
  filePath: string;
  sourceId: string;
  typeName: string;
  /** 'param' | 'return' | 'generic' | 'cast' */
  usageKind: string;
}

interface ExtractedThrow {
  filePath: string;
  sourceId: string;
  exceptionName: string;
}

// ── Parameter node extracted data ─────────────────────────────────────

interface ExtractedParameter {
  filePath: string;
  /** generateId('Parameter', `${filePath}:${funcName}:${paramName}`) */
  id: string;
  /** ID of the parent function/method/constructor node */
  parentId: string;
  name: string;
  startLine: number;
  endLine: number;
  ordinal: number;
  type?: string;           // resolved type name (from annotation or inference)
  isOptional: boolean;
  hasDefault: boolean;
  isRest: boolean;
  visibility?: 'public' | 'protected' | 'private'; // TS constructor promotion
}

// Enhance existing ExtractedCall (already has filePath, calledName, sourceId, etc.):
interface ExtractedCall {
  // ... existing fields ...

  /** True if call site is nested inside a branching construct */
  isConditional?: boolean;
  /** Short guard expression text, truncated to 120 chars */
  guardExpression?: string;
  /** Number of enclosing branching constructs (0 = unconditional) */
  branchDepth?: number;
}

// Add to ParseWorkerResult:
interface ParseWorkerResult {
  // ... existing fields ...
  parameters: ExtractedParameter[];
  fieldAccesses: ExtractedFieldAccess[];
  typeUsages: ExtractedTypeUsage[];
  throws: ExtractedThrow[];
}
```

## Subsystem Details

### 1. Schema Extension
**Files**: `gitnexus/src/core/graph/types.ts`, `gitnexus/src/types/pipeline.ts`, `gitnexus/src/core/ingestion/workers/parse-worker.ts` (type definitions only)
**Key decisions**:
- `Parameter` is a new node label. Each parameter becomes a graph node with `PARAM_OF` edge to its function and `USES_TYPE` edge to its type. ~6k nodes for a 50k LOC project — negligible for in-memory Graphology.
- Parameter nodes include `visibility` for TypeScript constructor parameter promotion (`constructor(private name: string)`).
- `complexity` and `sloc` are numbers, not categories — consumers set their own thresholds.
- New edge types use the same `confidence` + `reason` model as CALLS.

### 2. Complexity Extraction
**Files**: `gitnexus/src/core/ingestion/complexity.ts` (new), parse worker integration
**Key decisions**:
- Count branching AST node types per function body, same algorithm as codebase-memory-mcp's `cbm_count_branching`. Language-specific branching type sets.
- TypeScript/JavaScript branching types: `if_statement`, `for_statement`, `for_in_statement`, `while_statement`, `do_statement`, `switch_case`, `catch_clause`, `ternary_expression`, `logical_expression` (&&, ||), `optional_chain_expression`.
- Computed during the parse phase (inside parse worker) — no separate pipeline phase needed.
- `sloc` = `endLine - startLine + 1` (already have the data, just not stored).

### 3. Visibility & Accessor Extraction
**Files**: parse worker (inline in `processFileGroup`), TypeScript-specific AST patterns
**Key decisions**:
- TypeScript visibility: check for `accessibility_modifier` child on class member nodes. Values: `public`, `private`, `protected`. JS `#private` fields detected by `private_property_identifier` node type.
- Accessor detection: `method_definition` with `get` or `set` keyword child → `isAccessor: true`.
- `isReadonly`: TS `readonly` modifier on property declarations.
- `isStatic`: presence of `static` modifier child.
- `isAbstract`: presence of `abstract` modifier child.
- Default visibility when no modifier: `public` for TS (language spec), omitted for JS (no formal visibility).

### 4. Parameter Node Extraction
**Files**: parse worker (enhancement to definition extraction loop), extends existing `extractParameter` in type extractors
**Key decisions**:
- Walk `formal_parameters` / `parameter_list` child of function/method nodes.
- For each parameter: create a **`Parameter` node** with properties: `name`, `filePath`, `startLine`, `endLine`, `ordinal` (0-indexed position), `isOptional`, `hasDefault`, `isRest`, `visibility` (for TS constructor promotion), `returnType` (reused field — stores the parameter's type annotation).
- Create a **`PARAM_OF` edge** from the Parameter node to the parent Function/Method/Constructor node. Confidence 1.0, reason `ast-derived`.
- Create a **`USES_TYPE` edge** from the Parameter node to the resolved Class/Interface/Type node (when the param type is non-builtin). Resolution happens in the semantic edge phase (subsystem 5).
- TS constructor promotion: parameter with `accessibility_modifier` → create BOTH a Parameter node AND a Property node for the promoted field (with matching `visibility`).
- Existing `parameterCount` property stays on the parent node (backward compat).
- **ID scheme**: `generateId('Parameter', `${filePath}:${funcName}:${paramName}`)` — scoped to function to avoid collisions.

**Cost estimate** (50k LOC TS project):
- ~2,000 functions/methods × ~3 params avg = ~6,000 Parameter nodes
- ~6,000 PARAM_OF edges + ~4,000 USES_TYPE edges (non-builtin types) = ~10,000 edges
- Current graph: ~2,000 symbols, ~4,700 edges → new total: ~8,000 nodes, ~14,700 edges
- Memory: ~1.2MB additional. Index time: negligible (extraction is part of existing AST walk).

### 5. Semantic Edge Phase
**Files**: `gitnexus/src/core/ingestion/semantic-edge-processor.ts` (new)
**Depends on**: Subsystems 1, 3, 4 (needs visibility on target Property nodes, type env for receiver resolution)
**Key decisions**:
- Runs as a new pipeline sub-phase after calls/heritage resolution (between MRO and communities), using the same chunked pattern.
- **READS_FIELD / WRITES_FIELD**: Extracted in parse worker as `ExtractedFieldAccess`. Resolution in main thread uses type environment to resolve `receiverName` → `receiverType`, then looks up `Property` node owned by that class. Confidence: 1.0 if type-annotated receiver, 0.7 if inferred from constructor binding, 0.4 if unresolved (name-only match).
- **USES_TYPE**: Extracted from function parameter types and return types. Only non-builtin types (filter same list as codebase-memory-mcp: string, number, boolean, void, any, unknown, never, Promise, Array, Map, Set, Record, etc.). Resolution against Class/Interface/Type nodes in symbol table.
- **THROWS**: Extracted from `throw_statement` nodes in parse worker. Extract the constructor name from `new ErrorType()` pattern. Resolution against Class nodes.
- All three edge types are **extracted in parse worker** (AST walk) and **resolved in main thread** (symbol table lookup), same pattern as CALLS.

**Behavior** (resolution specifics):
- Field access extraction walks `member_expression` / `property_access_expression` nodes. Assignment target (left side of `=`, `+=`, etc.) → `write`; otherwise → `read`.
- For `this.field` access within a class: creates edge to own Property node with confidence 1.0 and reason `self-access`. Cross-class access: confidence depends on receiver type resolution.
- USES_TYPE edges are deduplicated per (source, target) pair — a function using `User` in both params and return gets one edge.

### 6. Call Conditionality
**Files**: `gitnexus/src/core/ingestion/workers/parse-worker.ts` (call extraction section)
**Key decisions**:
- During call extraction in the parse worker, walk **up** from each `call_expression` AST node counting enclosing branching constructs until reaching the enclosing function boundary.
- Branching construct types: `if_statement`, `else_clause`, `switch_case`, `ternary_expression`, `catch_clause`, `logical_expression` (`&&`, `||`, `??` — short-circuit operators are implicit branches).
- `branchDepth` = count of enclosing branching nodes. `isConditional` = `branchDepth > 0`.
- `guardExpression`: take the **nearest** enclosing branching construct's condition text. For `if_statement`, extract the `condition` field text. For `catch_clause`, literal string `"catch"`. For `&&`/`||`/`??`, extract the left-hand operand text. Truncate to 120 chars.
- This data is attached to each `ExtractedCall` record and flows through to the CALLS edge during call resolution in the main thread (subsystem already wired in `processCallsFromExtracted`).
- Unconditional calls: `isConditional` omitted (not `false`) to keep edge payloads small for the majority case.

**Behavior**:
- Loop bodies (`for`, `while`) are **not** counted as conditional — a call inside a loop is always-executed (just multiple times). Only truly branching constructs count.
- `try` blocks are **not** conditional — the call inside `try` is always attempted. Only `catch` is conditional.
- Ternary: both branches are conditional (the call may or may not execute depending on the condition).
- `guard` clauses (early return): `if (!x) return;` followed by a call — the call itself is unconditional relative to its position, the early return is what's conditional. Walk-up correctly handles this because the call is NOT inside the if body.

### 7. Layer & Quality MCP Tool
**Files**: `gitnexus/src/mcp/tools.ts` (add new tool definition + handler)
**Key decisions**:
- Single new MCP tool: `quality_query` with a `preset` parameter selecting from pre-built query templates. This is better than raw Cypher because the queries are complex multi-hop patterns that LLMs often get wrong.
- Presets expose **data**, not judgments. The tool returns results; the consumer decides what's a smell.

**Presets**:

| Preset | Returns | Cypher Pattern |
|--------|---------|---------------|
| `high_complexity` | Functions with complexity > threshold (param) | Filter on `complexity` property |
| `many_optionals` | Functions with >N optional params | Count PARAM_OF edges where `isOptional = true` |
| `dead_code` | Functions with 0 inbound CALLS (excluding entry points + test files) | Degree filter |
| `cross_class_field_access` | READS_FIELD/WRITES_FIELD edges crossing class boundaries | Join field access edges with visibility |
| `encapsulation_violations` | Cross-class access to private/protected fields | READS_FIELD/WRITES_FIELD + visibility filter |
| `unused_injections` | Constructor params with 0 downstream READS_FIELD from sibling methods | PARAM_OF → Constructor → Class → HAS_METHOD → Method, check READS_FIELD from method to promoted Property |
| `overused_injections` | Constructor params referenced by >80% of class methods | Same pattern, inverse threshold |
| `params_by_type` | All parameters across the codebase that use a given type | USES_TYPE from Parameter nodes to target type |
| `param_fan_in` | Types ranked by how many parameters reference them | Count inbound USES_TYPE from Parameter nodes |
| `type_coupling` | Classes/interfaces ranked by inbound USES_TYPE count | Degree on USES_TYPE |
| `layer_violations` | Calls from "leaf" layer to "entry" layer (dependency direction) | Fan-in/out heuristic + CALLS direction |
| `god_functions` | Functions with high complexity + high fan-out + many params | Compound filter |
| `throw_diversity` | Functions that throw >N distinct exception types | THROWS edge count |
| `accessor_vs_direct` | Field accesses that bypass getters (direct field read where getter exists) | Join READS_FIELD with accessor Property nodes |
| `conditional_calls` | CALLS edges from a given function, annotated with `isConditional`, `guardExpression`, `branchDepth` | Filter CALLS edges by source, return with conditionality metadata |
| `hot_path` | Call chain from function X showing only unconditional (branchDepth=0) calls — the always-executed path | BFS on CALLS edges filtered to `isConditional = false` |
| `guarded_paths` | Call chain from function X showing only conditional calls grouped by guard expression | BFS on CALLS edges filtered to `isConditional = true`, grouped by `guardExpression` |

## File Map

### New Files
| File | Subsystem | Purpose |
|------|-----------|---------|
| `gitnexus/src/core/ingestion/complexity.ts` | 2 | Language-specific branching type sets + `computeComplexity(node)` helper |
| `gitnexus/src/core/ingestion/semantic-edge-processor.ts` | 5 | Post-parse resolution of READS_FIELD, WRITES_FIELD, USES_TYPE, THROWS edges |

### Modified Files
| File | Change |
|------|--------|
| `gitnexus/src/core/graph/types.ts` | Add `complexity`, `sloc`, `visibility`, `isAccessor`, `isReadonly`, `isStatic`, `isAbstract`, `parameters` to `NodeProperties`. Add `READS_FIELD`, `WRITES_FIELD`, `USES_TYPE`, `THROWS` to `RelationshipType`. |
| `gitnexus/src/types/pipeline.ts` | Add `'semantic-edges'` to `PipelinePhase` union (between `'parsing'` and `'communities'`). |
| `gitnexus/src/core/ingestion/workers/parse-worker.ts` | Extract complexity, visibility, accessor, readonly, static, abstract, parameters, field accesses, type usages, throws, and **call-site conditionality** (isConditional, guardExpression, branchDepth) during AST walk. Add to `ParseWorkerResult`. |
| `gitnexus/src/core/ingestion/parsing-processor.ts` | Merge new extracted data from worker results. Pass field accesses / type usages / throws to semantic edge processor. |
| `gitnexus/src/core/ingestion/pipeline.ts` | Wire semantic-edge-processor between MRO and communities phases. |
| `gitnexus/src/mcp/tools.ts` | Add `quality_query` tool definition and handler with preset dispatch. |
| `gitnexus/src/core/ingestion/type-extractors/typescript.ts` | Enhance `extractParameter` to return full `ParameterDetail` (optionality, default, rest, promotion). |
| `gitnexus/src/core/ingestion/type-extractors/types.ts` | Extend `ParameterExtractor` signature or add `ParameterDetailExtractor` type. |

## Verification

1. **Complexity**: Index a TS project, run `quality_query({preset: 'high_complexity', threshold: 10})`. Verify returned functions actually have many branches by reading source.
2. **Encapsulation**: Create a test file where class A reads `b.#privateField`. Verify `quality_query({preset: 'encapsulation_violations'})` returns the access with the correct source/target.
3. **Parameter nodes**: Index a function `foo(a: string, b?: number, ...rest: any[])`. Verify 3 Parameter nodes exist with `PARAM_OF` edges to `foo`. Verify `a` has `isOptional: false`, `b` has `isOptional: true`, `rest` has `isRest: true`. Verify `a` has `USES_TYPE` edge to built-in (omitted) and `b` to built-in (omitted). Run `MATCH (p:Parameter)-[:PARAM_OF]->(f {name: 'foo'}) RETURN p.name, p.isOptional, p.ordinal` and verify results.
4. **Unused injection**: Create a class with 3 constructor params where one is never used in any method. Verify `quality_query({preset: 'unused_injections'})` returns it.
5. **USES_TYPE**: Verify that `quality_query({preset: 'type_coupling'})` returns interfaces/classes ranked by how many functions reference them in signatures.
6. **Call conditionality**: Create a function with `if (isAdmin) { deleteUser(); }` and `logAction();` outside the if. Verify `deleteUser` CALLS edge has `isConditional: true`, `guardExpression: "if (isAdmin)"`, `branchDepth: 1`, while `logAction` has no conditionality fields.
7. **Hot path tracing**: Run `quality_query({preset: 'hot_path', function: 'handleRequest'})`. Verify only unconditional calls appear in the chain, skipping error-handling and feature-flag branches.
8. **Backward compat**: Existing tests pass unchanged. `parameterCount` still populated. Existing Cypher queries still work. CALLS edges without conditionality metadata continue to work (fields are optional).

## Integration Tests

Each test fixture is a small TypeScript project (a few files) that gets indexed end-to-end via `runPipelineFromRepo`, then asserts on the resulting graph. Group by subsystem.

### Fixture: `fixtures/semantic-depth/visibility-and-access/`

**`user-service.ts`**:
```typescript
class User {
  public name: string;
  private email: string;
  protected age: number;
  #ssn: string;                    // JS private field
  readonly id: string;
  static count = 0;

  get fullName() { return this.name; }
  set fullName(v: string) { this.name = v; }

  private validate() { return this.#ssn.length > 0; }
}

class UserService {
  doStuff(user: User) {
    console.log(user.name);        // public read — ok
    console.log(user.email);       // private read — encapsulation violation
    user.age = 30;                 // protected write — encapsulation violation
  }
}
```

**Tests**:
- `User.name` Property node has `visibility: 'public'`
- `User.email` Property node has `visibility: 'private'`
- `User.#ssn` Property node has `visibility: 'private'`
- `User.id` Property node has `isReadonly: true`
- `User.count` Property node has `isStatic: true`
- `User.fullName` (get) Method node has `isAccessor: true`
- `UserService.doStuff` → `User.name` has `READS_FIELD` edge
- `UserService.doStuff` → `User.email` has `READS_FIELD` edge (cross-class, private target)
- `UserService.doStuff` → `User.age` has `WRITES_FIELD` edge (cross-class, protected target)
- `User.validate` → `User.#ssn` has `READS_FIELD` edge with reason `self-access`
- `quality_query({preset: 'encapsulation_violations'})` returns `email` and `age` accesses, NOT `name`

### Fixture: `fixtures/semantic-depth/parameters/`

**`api.ts`**:
```typescript
interface RequestContext { userId: string; traceId: string; }

function handleRequest(
  ctx: RequestContext,
  path: string,
  method: string = 'GET',
  timeout?: number,
  ...middleware: Function[]
) { /* ... */ }

class PaymentService {
  constructor(
    private db: Database,
    private logger: Logger,
    protected cache?: Cache,
  ) {}

  charge(amount: number, currency: string) {
    this.db.query('...');
    this.logger.log('charged');
    // note: this.cache never used in this class
  }

  refund(amount: number) {
    this.db.query('...');
    this.logger.log('refunded');
  }
}
```

**Tests**:
- `handleRequest` has 5 Parameter nodes with `PARAM_OF` edges
- `ctx` param: `ordinal: 0`, `isOptional: false`, `isRest: false`, has `USES_TYPE` edge → `RequestContext`
- `method` param: `ordinal: 2`, `hasDefault: true`, `isOptional: true` (has default = optional)
- `timeout` param: `ordinal: 3`, `isOptional: true`, `hasDefault: false`
- `middleware` param: `ordinal: 4`, `isRest: true`
- `PaymentService` constructor: 3 Parameter nodes
  - `db` param has `visibility: 'private'` — also creates a Property node `PaymentService.db` with `visibility: 'private'`
  - `cache` param has `visibility: 'protected'`, `isOptional: true`
- `quality_query({preset: 'many_optionals', threshold: 2})` returns `handleRequest` (3 optional: method, timeout, middleware)
- `quality_query({preset: 'unused_injections'})` returns `cache` (never referenced by `charge` or `refund`)
- `quality_query({preset: 'params_by_type', type: 'RequestContext'})` returns `ctx`
- `MATCH (p:Parameter)-[:USES_TYPE]->(t) RETURN t.name, COUNT(p)` includes `RequestContext: 1`, `Database: 1`, `Logger: 1`

### Fixture: `fixtures/semantic-depth/complexity/`

**`logic.ts`**:
```typescript
// Simple function — complexity 1 (no branching)
function add(a: number, b: number) { return a + b; }

// Medium — complexity 5
function classify(score: number): string {
  if (score > 90) return 'A';
  else if (score > 80) return 'B';
  else if (score > 70) return 'C';
  else if (score > 60) return 'D';
  return 'F';
}

// High — complexity 10+
function processOrder(order: Order) {
  if (!order) throw new InvalidOrderError('missing');
  if (!order.items) throw new InvalidOrderError('no items');
  for (const item of order.items) {
    if (item.quantity <= 0) continue;
    switch (item.type) {
      case 'physical': if (item.weight > 50) { /* ... */ } break;
      case 'digital': if (item.license) { /* ... */ } break;
      case 'subscription': if (item.interval && item.price > 0) { /* ... */ } break;
    }
  }
  if (order.coupon || order.discount) { /* ... */ }
}
```

**Tests**:
- `add` has `complexity: 0` (or 1 depending on base — document which convention), `sloc` = line count
- `classify` has `complexity: 4` (4 if-statements)
- `processOrder` has `complexity >= 10` (if + if + for + if + switch + 3 cases + if + if + logical_expression)
- `quality_query({preset: 'high_complexity', threshold: 8})` returns `processOrder`, not `add` or `classify`
- `quality_query({preset: 'god_functions'})` returns `processOrder` (high complexity + multiple calls + many params if adjusted)

### Fixture: `fixtures/semantic-depth/conditionality/`

**`handler.ts`**:
```typescript
function handlePayment(user: User, amount: number) {
  validateInput(amount);                           // unconditional — branchDepth 0

  if (user.isAdmin) {
    applyDiscount(amount);                         // conditional — branchDepth 1, guard "if (user.isAdmin)"
    if (amount > 1000) {
      requireApproval(user);                       // conditional — branchDepth 2, guard "if (amount > 1000)"
    }
  }

  const result = processCharge(amount);            // unconditional — branchDepth 0

  try {
    sendReceipt(user);                             // unconditional (try is not conditional)
  } catch (e) {
    logError(e);                                   // conditional — branchDepth 1, guard "catch"
  }

  user.isPremium && notifyVIP(user);               // conditional — branchDepth 1, guard "user.isPremium && ..."
  user.referrer ?? sendWelcome(user);              // conditional — branchDepth 1, guard "user.referrer ?? ..."

  for (const hook of hooks) {
    hook.run();                                    // unconditional (loop is not conditional)
  }

  return result;
}
```

**Tests**:
- `validateInput` CALLS edge: `isConditional` absent/undefined, `branchDepth` absent/0
- `applyDiscount` CALLS edge: `isConditional: true`, `branchDepth: 1`, `guardExpression` contains `user.isAdmin`
- `requireApproval` CALLS edge: `isConditional: true`, `branchDepth: 2`, `guardExpression` contains `amount > 1000`
- `processCharge` CALLS edge: unconditional
- `sendReceipt` CALLS edge: unconditional (try body is always attempted)
- `logError` CALLS edge: `isConditional: true`, `guardExpression: "catch"`
- `notifyVIP` CALLS edge: `isConditional: true`, `branchDepth: 1` (short-circuit `&&`)
- `sendWelcome` CALLS edge: `isConditional: true`, `branchDepth: 1` (nullish coalescing `??`)
- `hook.run` CALLS edge: unconditional (loop body always executes if loop runs)
- `quality_query({preset: 'hot_path', function: 'handlePayment'})` returns chain: `validateInput → processCharge → sendReceipt → hook.run`
- `quality_query({preset: 'guarded_paths', function: 'handlePayment'})` groups: `{guard: "user.isAdmin", calls: ["applyDiscount", "requireApproval"]}, {guard: "catch", calls: ["logError"]}, ...`

### Fixture: `fixtures/semantic-depth/type-edges/`

**`models.ts`**:
```typescript
interface Serializable { toJSON(): string; }
class AppError extends Error { code: number; }
class NotFoundError extends AppError {}

class UserRepo {
  find(id: string): User | null { /* ... */ }
  save(user: User): void {
    if (!user.id) throw new NotFoundError('missing id');
  }
}
```

**Tests**:
- `UserRepo.find` has `USES_TYPE` edge → `User` (return type, ignoring `null` as builtin)
- `UserRepo.save` has `USES_TYPE` edge → `User` (param type)
- `UserRepo.save` → `User` USES_TYPE is deduplicated (one edge even though `User` appears in both param and potentially body)
- `UserRepo.save` has `THROWS` edge → `NotFoundError`
- `quality_query({preset: 'type_coupling'})` includes `User` with count >= 2 (find + save reference it)
- `quality_query({preset: 'throw_diversity', threshold: 0})` returns `UserRepo.save` with 1 exception type

### Fixture: `fixtures/semantic-depth/cross-file/`

Two files to test cross-file resolution:

**`types.ts`**:
```typescript
export interface Config { retries: number; timeout: number; }
export class HttpClient {
  private baseUrl: string;
  constructor(private config: Config) {}
  get(path: string): Promise<Response> { /* ... */ }
}
```

**`service.ts`**:
```typescript
import { HttpClient, Config } from './types';

class ApiService {
  constructor(private client: HttpClient) {}

  fetchUser(id: string) {
    return this.client.get(`/users/${id}`);   // CALLS to HttpClient.get
  }
}
```

**Tests**:
- `ApiService.fetchUser` → `HttpClient.get` has CALLS edge (cross-file resolution)
- `ApiService.constructor` has Parameter node `client` with `USES_TYPE` → `HttpClient`
- `ApiService.fetchUser` has `READS_FIELD` edge → `ApiService.client` (self-access via `this.client`)
- `HttpClient.constructor` param `config` has `USES_TYPE` → `Config`
- Cross-file USES_TYPE edges resolve correctly (Config and HttpClient defined in different file)

### Fixture: `fixtures/semantic-depth/incremental/`

Test that incremental reindex handles new node/edge types correctly.

**Setup**: Index the project. Then modify one file (add a parameter, change visibility, add a throw statement). Re-index incrementally.

**Tests**:
- New Parameter node appears for the added parameter
- Old Parameter nodes for the modified function are removed and recreated
- New THROWS edge appears
- Visibility change on a Property node is reflected
- Unmodified files' Parameter nodes, READS_FIELD edges, etc. are unchanged
- `parameterCount` on the parent function updates correctly

### Test Harness Pattern

```typescript
describe('semantic-depth', () => {
  let graph: KnowledgeGraph;

  beforeAll(async () => {
    const result = await runPipelineFromRepo(
      fixturePath('semantic-depth/visibility-and-access'),
      () => {} // no-op progress
    );
    graph = result.graph;
  });

  // Helper: find node by label + name
  const findNode = (label: string, name: string) =>
    [...graph.iterNodes()].find(n => n.label === label && n.properties.name === name);

  // Helper: find edges by type from a source
  const findEdgesFrom = (sourceId: string, type: string) =>
    [...graph.iterRelationships()].filter(r => r.sourceId === sourceId && r.type === type);

  it('extracts private visibility on User.email', () => {
    const prop = findNode('Property', 'email');
    expect(prop?.properties.visibility).toBe('private');
  });

  it('creates READS_FIELD edge for cross-class private access', () => {
    const doStuff = findNode('Method', 'doStuff');
    const emailProp = findNode('Property', 'email');
    const edges = findEdgesFrom(doStuff!.id, 'READS_FIELD');
    expect(edges.some(e => e.targetId === emailProp!.id)).toBe(true);
  });
});
```
