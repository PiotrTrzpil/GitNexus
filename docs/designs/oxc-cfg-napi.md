# oxc-cfg NAPI Binding — Design

## Overview

Add intra-function control flow graph (CFG) data to GitNexus by building a NAPI binding around oxc's semantic analysis. The binding compiles as a native `.node` addon, callable from the parse worker exactly like tree-sitter: `const cfg = oxcCfg.analyze(sourceCode)` → structured JS objects, no JSON serialization, no subprocess. The CFG provides basic-block-level control flow within functions — a deeper layer beneath the existing inter-function CALLS edges — enabling dead-block detection, branch-path analysis, and precise conditionality extraction.

## Current State

- **What exists**: GitNexus parses TS/JS with tree-sitter in parse workers. CALLS edges have `isConditional` / `guardExpression` / `branchDepth` (from the semantic-depth design, AST-walk-based). No intra-function control flow.
- **What stays**: Tree-sitter parsing, all existing node/edge types, the parse worker architecture, the chunked pipeline. oxc CFG is additive — a second pass on the same source text.
- **What changes**: Parse worker gains a new native import. `ParseWorkerResult` gains a `cfgData` field. A new processor maps CFG data into graph nodes/edges. Graph types grow `BasicBlock` node label and `CFG_EDGE` / `CFG_CONTAINS` relationship types.

## Summary for Review

- **Interpretation**: Build a Rust NAPI binding (via napi-rs) that wraps oxc's parser + semantic builder + CFG. The binding exposes a single `analyzeCfg(filename, sourceCode)` function returning per-function CFG data as native JS objects. GitNexus calls it from the parse worker thread alongside tree-sitter. The CFG data flows through the existing chunked pipeline and materializes as graph nodes (basic blocks) and edges (control flow).
- **Key decisions**:
  - **Separate napi crate, not a fork of oxc**: We create `gitnexus/native/oxc-cfg-napi/` with a Rust crate that depends on `oxc` crates as cargo dependencies. This avoids forking the oxc monorepo while giving us full control over the JS API surface.
  - **Per-function subgraph splitting happens in Rust**: oxc's CFG is per-file. The Rust binding walks `NewFunction` edges to split into per-function subgraphs before returning, so JS gets clean per-function results.
  - **BasicBlock becomes a graph node**: Each basic block is a `BasicBlock` node with `CFG_CONTAINS` edge to its parent Function and `CFG_EDGE` edges between blocks. This makes CFG data queryable via the same Cypher/graph API as everything else.
  - **Condition text extraction in Rust**: For `Jump` edges (conditional branches), the Rust side extracts the condition expression source text from the AST span, so consumers get `"user.isAdmin"` not just `Jump`.
  - **Optional per-file**: CFG analysis is opt-in (disabled by default) and only runs for TS/JS files. Failures are non-fatal — the file's tree-sitter data still flows normally.
  - **oxc_cfg modification hints**: Document specific upstream changes that would improve our use case (optional chaining CFG edges, richer edge metadata).
- **Assumptions**: oxc v0.120.0 crates are the baseline. napi-rs v3 is used (same generation as current ecosystem). The binding is built as a prebuilt binary distributed alongside the npm package. Only TS/JS — other languages don't have oxc support.
- **Scope**: NAPI binding + pipeline integration + graph storage. No new MCP tools in this design (the existing `query_graph` / `search_graph` work on the new nodes). No UI changes.

## Conventions

- ES module syntax, `import`/`export`
- pnpm for packages, `tsc` for build
- Fail fast with contextual errors — no silent fallbacks for required dependencies
- Defensive code OK for external input (file parsing is an external boundary)
- Parse worker results are serializable (no Maps/functions) — transferred via `postMessage`
- Confidence scores: 1.0 for AST-derived facts
- Test with vitest (`vitest run test/unit`)
- Native optional deps pattern: wrap `require()` in try/catch, skip gracefully if unavailable (same as tree-sitter-kotlin/swift)

## Architecture

### Subsystems

| # | Subsystem | Responsibility | Depends On | Files |
|---|-----------|---------------|------------|-------|
| 1 | Rust NAPI Binding | Parse TS/JS with oxc, run semantic analysis with CFG, split per-function, return structured JS objects | — | `gitnexus/native/oxc-cfg-napi/` |
| 2 | TypeScript Type Definitions | TS types for the NAPI binding's return values, importable by the parse worker | 1 | `gitnexus/native/oxc-cfg-napi/index.d.ts` |
| 3 | Parse Worker Integration | Call `analyzeCfg()` from the parse worker, attach results to `ParseWorkerResult` | 1, 2 | `gitnexus/src/core/ingestion/workers/parse-worker.ts` |
| 4 | CFG Processor | Map extracted CFG data into graph nodes (`BasicBlock`) and edges (`CFG_EDGE`, `CFG_CONTAINS`) | 3 | `gitnexus/src/core/ingestion/cfg-processor.ts` |
| 5 | Schema Extension | New node label, edge types, node properties for CFG data | — | `gitnexus/src/core/graph/types.ts` |
| 6 | Pipeline Wiring | Call CFG processor in the chunked pipeline, alongside existing call/heritage/route resolution | 4, 5 | `gitnexus/src/core/ingestion/pipeline.ts` |
| 7 | Build & Distribution | napi-rs build config, platform-specific prebuilt binaries, postinstall script, CI | 1 | `gitnexus/native/oxc-cfg-napi/Cargo.toml`, `package.json`, build scripts |

## Shared Contracts

```typescript
// ── NAPI binding return types (index.d.ts) ────────────────────────────

/** Top-level result from analyzeCfg() */
export interface CfgAnalysisResult {
  functions: FunctionCfg[];
  /** Parsing/semantic errors (non-fatal — partial results may still be returned) */
  errors: CfgError[];
}

export interface CfgError {
  message: string;
  startLine: number;
  endLine: number;
}

/** Per-function control flow graph */
export interface FunctionCfg {
  /** Function/method name (e.g., "handlePayment", "User.constructor", "anonymous@42") */
  name: string;
  /** Start line of the function in source (1-indexed) */
  startLine: number;
  /** End line of the function in source (1-indexed) */
  endLine: number;
  /** Enclosing class name, if this is a method */
  className: string | null;
  /** Basic blocks in this function's CFG */
  blocks: CfgBlock[];
  /** Control flow edges between blocks */
  edges: CfgEdge[];
}

export interface CfgBlock {
  /** Block ID, unique within this function (0 = entry block) */
  id: number;
  /** Instructions/statements in this block */
  instructions: CfgInstruction[];
  /** True if this block is statically unreachable */
  unreachable: boolean;
}

export interface CfgInstruction {
  /** Instruction kind */
  kind: 'Statement' | 'Condition' | 'Return' | 'ImplicitReturn'
      | 'Break' | 'Continue' | 'Throw' | 'Iteration' | 'Unreachable';
  /** Source location (1-indexed). Null for synthetic instructions. */
  startLine: number | null;
  endLine: number | null;
  startColumn: number | null;
  endColumn: number | null;
  /**
   * Source text of the instruction, truncated to 200 chars.
   * For Condition instructions: the condition expression text.
   * For Statement: omitted (null) to save memory — use line numbers to look up source.
   * For Return/Throw: the expression text if present.
   */
  text: string | null;
}

export interface CfgEdge {
  /** Source block ID */
  source: number;
  /** Target block ID */
  target: number;
  /** Edge type */
  type: 'Jump' | 'Normal' | 'Backedge' | 'Finalize' | 'ErrorExplicit'
      | 'ErrorImplicit' | 'Unreachable' | 'Join';
  /**
   * For Jump edges: the condition expression text that guards this branch (e.g., "user.isAdmin").
   * For ErrorExplicit: the thrown expression text.
   * Null for other edge types.
   * Truncated to 120 chars.
   */
  conditionText: string | null;
}

/** Synchronous entry point — called from parse worker thread */
export function analyzeCfg(filename: string, sourceCode: string, options?: CfgOptions): CfgAnalysisResult;

export interface CfgOptions {
  /**
   * Source type override. Default: inferred from filename extension.
   * 'typescript' | 'javascript' | 'tsx' | 'jsx'
   */
  sourceType?: string;
  /** Include instruction text for Statement instructions (default: false — saves memory) */
  includeStatementText?: boolean;
  /** Max functions to analyze per file (default: 500 — safety valve for generated code) */
  maxFunctions?: number;
}

// ── Extracted CFG data (parse worker → main thread) ──────────────────

/** Serializable CFG data for one file, attached to ParseWorkerResult */
export interface ExtractedFileCfg {
  filePath: string;
  functions: ExtractedFunctionCfg[];
}

/**
 * Per-function CFG after NAPI call, ready for postMessage transfer.
 * Same shape as FunctionCfg but with filePath context added.
 */
export interface ExtractedFunctionCfg {
  /** Function name */
  name: string;
  /** generateId of the corresponding Function/Method node (matched by name+line) */
  symbolId: string | null;
  startLine: number;
  endLine: number;
  className: string | null;
  blocks: CfgBlock[];
  edges: CfgEdge[];
}

// ── Graph schema additions ──────────────────────────────────────────

// Add to NodeLabel:
//   | 'BasicBlock'

// Add to NodeProperties:
//   blockIndex?: number;       // Block ID within its function's CFG (0 = entry)
//   instructionCount?: number; // Number of instructions in this block
//   isUnreachable?: boolean;   // True if statically unreachable
//   cfgInstructions?: string;  // JSON-encoded instruction array (compact storage)

// Add to RelationshipType:
//   | 'CFG_CONTAINS'   // Function/Method → BasicBlock (function contains this block)
//   | 'CFG_EDGE'       // BasicBlock → BasicBlock (control flow edge)

// Add to GraphRelationship (optional properties):
//   cfgEdgeType?: string;       // 'Jump' | 'Normal' | 'Backedge' | etc.
//   conditionText?: string;     // Guard expression for Jump edges (≤120 chars)
```

```rust
// ── Rust NAPI structs (lib.rs) ──────────────────────────────────────

use napi_derive::napi;

#[napi(object)]
pub struct CfgAnalysisResult {
    pub functions: Vec<FunctionCfg>,
    pub errors: Vec<CfgError>,
}

#[napi(object)]
pub struct CfgError {
    pub message: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[napi(object)]
pub struct FunctionCfg {
    pub name: String,
    pub start_line: u32,
    pub end_line: u32,
    pub class_name: Option<String>,
    pub blocks: Vec<CfgBlock>,
    pub edges: Vec<CfgEdge>,
}

#[napi(object)]
pub struct CfgBlock {
    pub id: u32,
    pub instructions: Vec<CfgInstruction>,
    pub unreachable: bool,
}

#[napi(object)]
pub struct CfgInstruction {
    pub kind: String,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub start_column: Option<u32>,
    pub end_column: Option<u32>,
    pub text: Option<String>,
}

#[napi(object)]
pub struct CfgEdge {
    pub source: u32,
    pub target: u32,
    #[napi(js_name = "type")]
    pub edge_type: String,
    pub condition_text: Option<String>,
}

#[napi(object)]
pub struct CfgOptions {
    pub source_type: Option<String>,
    pub include_statement_text: Option<bool>,
    pub max_functions: Option<u32>,
}

#[napi]
pub fn analyze_cfg(
    filename: String,
    source_code: String,
    options: Option<CfgOptions>,
) -> CfgAnalysisResult {
    // parse → semantic → iterate CFG → split per-function → return
}
```

## Subsystem Details

### 1. Rust NAPI Binding
**Files**: `gitnexus/native/oxc-cfg-napi/src/lib.rs`, `gitnexus/native/oxc-cfg-napi/src/splitter.rs`, `gitnexus/native/oxc-cfg-napi/Cargo.toml`
**Key decisions**:
- **Single `analyze_cfg` entry point**: Parse + semantic + CFG in one call. No incremental/cached state between calls — each invocation is stateless. This matches the worker thread model (parse worker processes one file at a time).
- **Per-function splitting via `NewFunction` edge traversal** (`splitter.rs`): Starting from the file's entry block (index 0), DFS the petgraph. When a `NewFunction` edge is encountered, record the target as a new function's entry block and stop traversal on that path. Continue DFS for each function subgraph independently. Remap block IDs to 0-indexed per function.
- **Function name resolution**: Each function's entry block is created by `new_basic_block_function()` in oxc_cfg. The corresponding AST node is the function/arrow/method node. Use `semantic.nodes().cfg_id(node_id)` to find which CFG block each AST function node maps to, then match entry blocks to function names.
- **Condition text extraction**: For `Jump` edges, walk backwards from the edge's source block to find the nearest `Condition` instruction. Use its `node_id` to get the AST node, then slice the source text at the node's span. Truncate to 120 chars.
- **Source text slicing**: The `source_code` string is available in the binding. Use `AstNode.kind().span()` to get byte offsets, then slice `&source_code[span.start as usize..span.end as usize]`. Convert to line/column using oxc_span utilities.
- **Error handling**: Parse errors and semantic errors are collected into `errors`. If parsing fails completely, return `{ functions: [], errors: [...] }`. Partial results are fine — a function with a parse error in its body may still have a partial CFG.

**Behavior** (per-function splitting algorithm):
1. Collect all function/method/arrow AST nodes from `semantic.nodes()`. For each, record `(node_id, name, start_line, end_line, class_name)`.
2. Map each function AST node to its CFG entry block via `semantic.nodes().cfg_id(node_id)`.
3. For each function, BFS/DFS from its entry block. Include all reachable blocks that are NOT separated by a `NewFunction` edge. Collect edges within the subgraph.
4. Remap block IDs to 0-based sequence per function. Block 0 = entry block.
5. For the file's top-level code (block 0 of the whole-file CFG), create a synthetic function named `<module>` or `<top-level>`.

### 2. TypeScript Type Definitions
**Files**: `gitnexus/native/oxc-cfg-napi/index.d.ts`, `gitnexus/native/oxc-cfg-napi/package.json`
**Key decisions**:
- napi-rs auto-generates `.d.ts` from the `#[napi]` Rust types. We use the generated file directly — no hand-written types. The types in Shared Contracts above describe the expected output.
- The `package.json` is internal (not published to npm). It declares the native binding as a local dependency: `"@gitnexus/oxc-cfg": "file:native/oxc-cfg-napi"` in the main `gitnexus/package.json`.

### 3. Parse Worker Integration
**Files**: `gitnexus/src/core/ingestion/workers/parse-worker.ts`
**Key decisions**:
- **Optional import with try/catch**, same pattern as tree-sitter-kotlin/swift:
  ```typescript
  let oxcCfg: typeof import('@gitnexus/oxc-cfg') | null = null;
  try { oxcCfg = require('@gitnexus/oxc-cfg'); } catch {}
  ```
- **Called after tree-sitter parsing**, using the same `file.content` already in memory. No second file read.
- **Only for TS/JS files**: Check `language` before calling. Skip non-TS/JS.
- **Non-fatal**: If `analyzeCfg` throws, log warning and continue. The file's tree-sitter results still flow normally.
- **Symbol ID matching**: For each `FunctionCfg` returned, attempt to match to the tree-sitter-extracted function node by `(name, startLine)`. If matched, set `symbolId` to the generateId of that node. If no match (anonymous functions, name mismatch), set `symbolId = null` — the CFG processor will match by line range as fallback.
- **Result shape**: Add `cfgData: ExtractedFileCfg[]` to `ParseWorkerResult`. Each file gets one entry (or none if CFG analysis failed/skipped).

### 4. CFG Processor
**Files**: `gitnexus/src/core/ingestion/cfg-processor.ts` (new)
**Key decisions**:
- **One `BasicBlock` node per block**, with `CFG_CONTAINS` edge to parent Function/Method.
- **One `CFG_EDGE` relationship per control flow edge**, with `cfgEdgeType` and `conditionText` properties.
- **Node ID scheme**: `generateId('BasicBlock', \`${functionNodeId}:${blockIndex}\`)`. Deterministic, avoids collisions across functions.
- **Instructions stored as JSON string**: `cfgInstructions` property is a `JSON.stringify(block.instructions)`. This keeps the graph schema flat (no nested objects in node properties) while preserving full instruction detail for consumers that need it.
- **Symbol ID fallback matching**: If `symbolId` is null, find the Function/Method node whose `(filePath, startLine, endLine)` range encompasses the `FunctionCfg`'s `(startLine, endLine)`. Prefer exact startLine match.
- **Incremental-safe**: In incremental mode, when a file is re-parsed, all `BasicBlock` nodes and `CFG_EDGE`/`CFG_CONTAINS` relationships for functions in that file are removed before re-adding. Use `removeNodesByFile` pattern (filter by `filePath` on BasicBlock nodes).

### 5. Schema Extension
**Files**: `gitnexus/src/core/graph/types.ts`
**Key decisions**:
- Add `'BasicBlock'` to `NodeLabel` union.
- Add `'CFG_CONTAINS' | 'CFG_EDGE'` to `RelationshipType` union.
- Add optional properties to `NodeProperties`: `blockIndex`, `instructionCount`, `isUnreachable`, `cfgInstructions`.
- Add optional properties to `GraphRelationship`: `cfgEdgeType`, `conditionText`.

### 6. Pipeline Wiring
**Files**: `gitnexus/src/core/ingestion/pipeline.ts`
**Key decisions**:
- CFG processing runs inside the existing chunk loop, in the `Promise.all` block alongside `processCallsFromExtracted`, `processHeritageFromExtracted`, `processRoutesFromExtracted`. No new pipeline phase — it's part of the parsing phase.
- CFG processing is independent of call/heritage/route resolution (no shared mutable state), so running in parallel is safe.
- Progress reporting: `Resolving CFG (chunk X/Y)...`

### 7. Build & Distribution
**Files**: `gitnexus/native/oxc-cfg-napi/Cargo.toml`, `gitnexus/native/oxc-cfg-napi/package.json`, `gitnexus/native/oxc-cfg-napi/build.rs`, `gitnexus/scripts/build-oxc-cfg.cjs` (new)
**Key decisions**:
- **Cargo.toml** depends on:
  - `oxc_parser` (v0.120.x) — parser
  - `oxc_semantic` (v0.120.x, features = ["cfg"]) — semantic analysis with CFG
  - `oxc_span` (v0.120.x) — source spans
  - `oxc_allocator` (v0.120.x) — arena allocator
  - `napi` (v3) + `napi-derive` (v3) — NAPI binding generation
  - `petgraph` (v0.7) — graph traversal for subgraph splitting (same version oxc uses)
- **Build script** (`build-oxc-cfg.cjs`): Invoked from `postinstall`. Checks if prebuilt binary exists for the current platform/arch. If not, runs `cargo build --release` (requires Rust toolchain). Same pattern as tree-sitter's rebuild fallback.
- **Prebuilt binaries**: For CI/releases, build for `darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`, `win32-x64-msvc`. Store as GitHub release assets or npm optional dependencies (`@gitnexus/oxc-cfg-darwin-arm64`, etc.).
- **Graceful degradation**: If the binding isn't available (no prebuilt, no Rust toolchain), GitNexus works normally without CFG data. Console warning on first index: `"oxc-cfg native binding not available — CFG analysis disabled. Install Rust toolchain or use a prebuilt binary."`

## Hints for Upstream oxc_cfg Modifications

These are potential contributions to the oxc project that would improve GitNexus's use case. They're **not blockers** — we can work around all of them — but they'd make the CFG richer.

### 1. Optional Chaining (`?.`) CFG Edges
**Current**: `a?.b?.c()` is treated as a single statement — no branching in the CFG.
**Desired**: Each `?.` creates a conditional branch: one path continues the chain, the other short-circuits to `undefined`. This would generate `Jump` ("chain continues") and `Normal` ("short-circuit to undefined") edges.
**Where to change**: `oxc_semantic/src/builder.rs`, in the visitor for `ChainExpression` / `OptionalMemberExpression` / `OptionalCallExpression`. Create a new basic block for the continuation, add `Jump`/`Normal` edges.
**Complexity**: Medium. The main challenge is that `?.` can appear mid-expression (`a?.b.c` — if `a` is null, `c` is never accessed), so the CFG needs to model expression-level branching, not just statement-level.
**Workaround**: GitNexus's tree-sitter AST walk already detects `optional_chain_expression` for `isConditional` on CALLS edges. The CFG just won't have block-level detail for these.

### 2. Nullish Coalescing (`??`) and Logical Assignment (`??=`, `||=`, `&&=`)
**Current**: Treated as regular expressions — no branching.
**Desired**: `a ?? b` creates two paths: one where `a` is non-nullish (result is `a`), one where it's nullish (evaluate `b`). Similar to how `&&`/`||` already should be modeled.
**Where to change**: Same visitor area as optional chaining. Logical expressions with `&&`/`||` likely already have some handling (they're `Condition` instructions) but `??` may not.
**Complexity**: Low-medium. The semantics are simpler than `?.` since it's a binary operator.

### 3. Richer Edge Metadata — Condition AST Node ID
**Current**: `EdgeType::Jump` carries no data — it's a unit variant.
**Desired**: `EdgeType::Jump(Option<NodeId>)` carrying the AST node ID of the condition expression. This would eliminate the need for our "walk backwards to find Condition instruction" heuristic in the splitter.
**Where to change**: `oxc_cfg/src/lib.rs` (EdgeType enum), `oxc_cfg/src/builder/mod.rs` (where edges are added).
**Complexity**: Low. The condition node ID is already known at the point where `Jump` edges are created — it just needs to be attached to the edge.

### 4. Per-Function Subgraph API
**Current**: `NewFunction` edges connect function subgraphs, but there's no built-in API to extract a single function's subgraph.
**Desired**: `cfg.function_subgraph(entry_block) -> SubGraph { blocks, edges }` that returns a disconnected subgraph for one function.
**Where to change**: `oxc_cfg/src/lib.rs`, new method on `ControlFlowGraph`.
**Complexity**: Low. The traversal logic is straightforward — it's what our `splitter.rs` does anyway.

### 5. Async/Await Suspension Points
**Current**: `await` is treated as a regular statement.
**Desired**: `await expr` creates a suspension point — conceptually, the function yields and may resume later. This could be modeled as a new `EdgeType::Suspend` with a "resume" edge back.
**Where to change**: Visitor for `AwaitExpression` in `oxc_semantic/src/builder.rs`.
**Complexity**: High. Async semantics are complex — `await` in a loop, `await` in try/catch, `Promise.all` patterns. The CFG model would need to distinguish "synchronous continuation" from "async resume". Likely not worth pursuing upstream until there's clear demand from multiple consumers.

### 6. Generator Yield Points
**Current**: `yield` / `yield*` treated as regular statements.
**Desired**: Similar to await — `yield` is a suspension/resume point.
**Complexity**: High, same reasons as async/await. Even less demand.

## File Map

### New Files
| File | Subsystem | Purpose |
|------|-----------|---------|
| `gitnexus/native/oxc-cfg-napi/Cargo.toml` | 1, 7 | Rust crate manifest — oxc + napi-rs dependencies |
| `gitnexus/native/oxc-cfg-napi/build.rs` | 7 | napi-rs build hook |
| `gitnexus/native/oxc-cfg-napi/src/lib.rs` | 1 | NAPI entry point — `analyze_cfg()` function, struct definitions |
| `gitnexus/native/oxc-cfg-napi/src/splitter.rs` | 1 | Per-function CFG subgraph extraction from whole-file CFG |
| `gitnexus/native/oxc-cfg-napi/src/text.rs` | 1 | Source text extraction — condition text, instruction text from AST spans |
| `gitnexus/native/oxc-cfg-napi/package.json` | 2, 7 | npm package metadata, napi-rs targets, build scripts |
| `gitnexus/native/oxc-cfg-napi/index.d.ts` | 2 | Auto-generated TypeScript type definitions (napi-rs output) |
| `gitnexus/src/core/ingestion/cfg-processor.ts` | 4 | Map ExtractedFileCfg → BasicBlock nodes + CFG_EDGE/CFG_CONTAINS relationships |
| `gitnexus/scripts/build-oxc-cfg.cjs` | 7 | Postinstall: check for prebuilt binary, fallback to cargo build |

### Modified Files
| File | Change |
|------|--------|
| `gitnexus/src/core/graph/types.ts` | Add `BasicBlock` to NodeLabel. Add `CFG_CONTAINS`, `CFG_EDGE` to RelationshipType. Add `blockIndex`, `instructionCount`, `isUnreachable`, `cfgInstructions` to NodeProperties. Add `cfgEdgeType`, `conditionText` to GraphRelationship. |
| `gitnexus/src/core/ingestion/workers/parse-worker.ts` | Import oxc-cfg binding (try/catch). Call `analyzeCfg()` per TS/JS file. Match results to tree-sitter function nodes. Add `cfgData` to ParseWorkerResult. |
| `gitnexus/src/core/ingestion/pipeline.ts` | Import cfg-processor. Add `processCfgFromExtracted()` to the Promise.all block in the chunk loop. |
| `gitnexus/package.json` | Add `"@gitnexus/oxc-cfg": "file:native/oxc-cfg-napi"` to optionalDependencies. Update postinstall script. |

## Verification

1. **Basic round-trip**: Create a TS file with a function containing `if/else`, a loop, and a `try/catch`. Run `analyzeCfg()` directly. Verify the returned `FunctionCfg` has blocks for each branch, edges with correct types (`Jump`/`Normal`/`Backedge`/`Error`), and `conditionText` on the `Jump` edge matches the `if` condition.
2. **Per-function splitting**: Create a file with 3 functions (one top-level, one class method, one arrow function). Verify `analyzeCfg()` returns 4 entries: `<top-level>`, function, method, arrow. Verify block IDs are 0-indexed per function, not globally.
3. **Pipeline integration**: Run `npx gitnexus analyze` on a small TS project. Verify `BasicBlock` nodes exist in the graph with correct `CFG_CONTAINS` edges to their parent Function nodes. Verify `CFG_EDGE` relationships have correct `cfgEdgeType` values.
4. **Graceful degradation**: Uninstall the native binding (or simulate with a broken `.node` file). Verify `npx gitnexus analyze` completes successfully with a warning, producing a graph identical to pre-CFG behavior (no BasicBlock nodes, no CFG_EDGE edges, all other data intact).
5. **Incremental**: Index a project, modify one TS file, re-index. Verify only that file's BasicBlock nodes are replaced. Other files' CFG data is preserved.
6. **Unreachable blocks**: Create a function with code after a `return` statement. Verify the CFG contains an unreachable block with `isUnreachable: true`.

## Integration Tests

Tests live in `gitnexus/test/integration/cfg/`. Each test creates inline TS/JS source strings, runs the binding and/or pipeline, and asserts on the output. Use vitest.

### Layer 1: NAPI Binding (Rust → JS boundary)

These test `analyzeCfg()` directly — no pipeline, no graph. Fast, isolated, verify the Rust binding produces correct JS objects.

**File**: `gitnexus/test/integration/cfg/analyze-cfg.test.ts`

#### 1.1 Linear function
```typescript
const src = `function greet(name: string) { console.log(name); return name; }`;
```
- Expect 1 function (`greet`), blocks form a straight line (no branches).
- All edges are `Normal`.
- Last instruction is `Return`.
- `startLine`/`endLine` on the function match the source.

#### 1.2 If/else branching
```typescript
const src = `
function check(x: number) {
  if (x > 0) {
    return "positive";
  } else {
    return "non-positive";
  }
}`;
```
- Expect ≥3 blocks: entry (with Condition instruction), true branch, false branch.
- One `Jump` edge from entry block with `conditionText` containing `x > 0`.
- One `Normal` edge from entry block (the else path).
- Both branches end with `Return` instructions.

#### 1.3 Loops — for, while, do-while
```typescript
const src = `
function loopy() {
  for (let i = 0; i < 10; i++) { process(i); }
  while (true) { if (done()) break; }
  do { step(); } while (hasMore());
}`;
```
- Expect `Backedge` edges (at least one per loop).
- Expect `Iteration` instructions.
- The `while (true)` loop should have `conditionText` containing `true` or similar.
- `break` should produce a `Break` instruction and an edge out of the loop body.

#### 1.4 Try/catch/finally
```typescript
const src = `
function risky() {
  try {
    dangerousOp();
  } catch (e) {
    handleError(e);
  } finally {
    cleanup();
  }
}`;
```
- Expect `ErrorExplicit` edge from try body to catch block.
- Expect `Finalize` edge into the finally block.
- Catch block should have a `Throw`-related instruction or statement.
- Finally block is reachable from both normal and error paths.

#### 1.5 Switch statement
```typescript
const src = `
function route(action: string) {
  switch (action) {
    case "create": return create();
    case "update": return update();
    case "delete": return deleteThing();
    default: throw new Error("unknown");
  }
}`;
```
- Expect one block per case (or at least distinct blocks for each `return`/`throw`).
- No fallthrough — each case has a `Return` or `Throw` instruction.
- `conditionText` on edges should reference case values or the discriminant.

#### 1.6 Nested functions produce separate FunctionCfg entries
```typescript
const src = `
function outer() {
  const inner = () => { return 1; };
  function named() { return 2; }
  return inner() + named();
}`;
```
- Expect 3+ function entries: `outer`, `inner` (or `anonymous@...`), `named`, plus `<top-level>`.
- Each has independent block IDs starting at 0.
- `outer`'s CFG does NOT contain blocks from `inner` or `named`.

#### 1.7 Class methods
```typescript
const src = `
class Calculator {
  add(a: number, b: number) { return a + b; }
  divide(a: number, b: number) {
    if (b === 0) throw new Error("div by zero");
    return a / b;
  }
}`;
```
- Expect function entries with `className: "Calculator"`.
- `divide` has a `Jump` edge with `conditionText` containing `b === 0`.
- `divide` has a `Throw` instruction in the true branch.

#### 1.8 Async/await (current behavior — no suspension edges)
```typescript
const src = `
async function fetchData(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("HTTP error");
  return await response.json();
}`;
```
- `await` appears as regular `Statement` instructions (no special edge type).
- The `if (!response.ok)` still produces proper `Jump`/`Normal` branching.
- Document this as a known limitation in test comments.

#### 1.9 Early return / guard clauses
```typescript
const src = `
function process(input: string | null) {
  if (!input) return;
  if (input.length === 0) return;
  doWork(input);
}`;
```
- Each guard clause creates a `Jump` edge (to early return) and `Normal` edge (to next statement).
- The `doWork(input)` call is in a block reachable only through both `Normal` edges.
- `Return` instructions on the early-return blocks.

#### 1.10 Ternary expressions
```typescript
const src = `
function pick(flag: boolean) {
  const result = flag ? computeA() : computeB();
  return result;
}`;
```
- Expect branching: `Jump`/`Normal` edges from the ternary condition.
- `conditionText` should contain `flag`.

#### 1.11 Logical operators as control flow (`&&`, `||`)
```typescript
const src = `
function shortCircuit(a: any, b: any) {
  a && doSomething();
  b || fallback();
}`;
```
- `&&` and `||` should produce `Condition` instructions.
- At least some branching structure (the short-circuit path vs the evaluation path).

#### 1.12 Unreachable code
```typescript
const src = `
function dead() {
  return 42;
  console.log("never");
  const x = 1;
}`;
```
- Block(s) containing `console.log("never")` and `const x = 1` should have `unreachable: true`.

#### 1.13 Empty function
```typescript
const src = `function noop() {}`;
```
- Expect 1 function with 1 block containing an `ImplicitReturn` instruction.
- No edges (or a single self-referencing edge — verify what oxc produces).

#### 1.14 JavaScript (not TypeScript)
```typescript
const src = `function add(a, b) { return a + b; }`;
// Call with filename "test.js" instead of "test.ts"
```
- Verify the binding handles `.js` files correctly (no type annotations, different source type).

#### 1.15 Parse errors — partial results
```typescript
const src = `
function valid() { return 1; }
function broken( { return; }
function alsoValid() { return 2; }`;
```
- `errors` array should be non-empty.
- At least `valid` and `alsoValid` should appear in `functions` (partial results).

#### 1.16 Large file stress test
- Generate a file with 500 functions, each with an `if/else`.
- Verify `analyzeCfg()` completes without panic or hang.
- Verify the `maxFunctions` option (set to 10) truncates the output to 10 functions.

### Layer 2: Parse Worker Integration

These test that CFG data flows correctly through the worker thread boundary.

**File**: `gitnexus/test/integration/cfg/parse-worker-cfg.test.ts`

#### 2.1 Worker returns cfgData
- Send a TS file through the parse worker (via `worker_threads` or the `processParsing` function).
- Verify `ParseWorkerResult.cfgData` contains an `ExtractedFileCfg` entry for that file.
- Verify `functions` array is populated with correct names.

#### 2.2 Symbol ID matching
- Send a file with a named function `handleRequest`.
- Verify the `ExtractedFunctionCfg` for `handleRequest` has `symbolId` matching the `generateId('Function', ...)` of the tree-sitter-extracted node.
- Verify line numbers match between tree-sitter node and CFG function entry.

#### 2.3 Non-TS/JS files produce no cfgData
- Send a Python file through the worker.
- Verify `cfgData` is empty or does not contain an entry for that file.

#### 2.4 Binding unavailable — graceful skip
- Mock the native binding import to throw.
- Verify the worker still returns valid `ParseWorkerResult` with all other fields populated.
- Verify `cfgData` is empty.

### Layer 3: CFG Processor (extracted data → graph)

These test the `processCfgFromExtracted()` function in isolation.

**File**: `gitnexus/test/integration/cfg/cfg-processor.test.ts`

#### 3.1 Nodes and edges are created
- Create a `KnowledgeGraph`, add a Function node manually.
- Call `processCfgFromExtracted()` with a hand-crafted `ExtractedFileCfg` (2 blocks, 1 edge).
- Verify: 2 `BasicBlock` nodes exist with correct `blockIndex`, `instructionCount`, `isUnreachable`.
- Verify: 1 `CFG_EDGE` relationship with correct `cfgEdgeType`.
- Verify: 2 `CFG_CONTAINS` relationships from Function → each BasicBlock.

#### 3.2 Node ID determinism
- Run `processCfgFromExtracted()` twice with the same input.
- Verify node IDs and relationship IDs are identical both times.

#### 3.3 Symbol ID fallback matching
- Create a Function node at lines 10-20.
- Pass an `ExtractedFunctionCfg` with `symbolId: null`, `startLine: 10`, `endLine: 20`.
- Verify the processor matches it to the Function node by line range.

#### 3.4 Orphaned CFG data (no matching Function node)
- Pass an `ExtractedFunctionCfg` with `symbolId: null`, lines that don't match any node.
- Verify no `BasicBlock` nodes are created (skip gracefully, no crash).

#### 3.5 cfgInstructions JSON encoding
- Create a block with 3 instructions of different kinds.
- Verify `cfgInstructions` property is valid JSON that round-trips to the original instruction array.

### Layer 4: Full Pipeline (end-to-end)

These test the entire flow: files on disk → pipeline → graph with CFG data.

**File**: `gitnexus/test/integration/cfg/pipeline-cfg.test.ts`

Use a temporary directory with small fixture files. Clean up after each test.

#### 4.1 Index a small TS project
- Create 3 TS files: one with a class (2 methods), one with 2 functions, one with a top-level script.
- Run `runPipelineFromRepo()`.
- Verify `BasicBlock` nodes exist for every Function/Method node.
- Verify `CFG_CONTAINS` edges link each BasicBlock to its parent.
- Verify `CFG_EDGE` edges exist with non-empty `cfgEdgeType`.
- Verify total node count is reasonable (original symbols + basic blocks).

#### 4.2 Mixed language project
- Create a project with TS, JS, and Python files.
- Run pipeline.
- Verify CFG data exists for TS and JS functions but NOT for Python functions.

#### 4.3 Incremental re-index
- Index a project with 2 TS files (fileA.ts, fileB.ts).
- Record the BasicBlock node IDs for both files.
- Modify fileA.ts (add an `if` statement to a function).
- Re-index.
- Verify: fileA's BasicBlock nodes are replaced (new IDs, more blocks due to the `if`).
- Verify: fileB's BasicBlock nodes are unchanged (same IDs, same count).

#### 4.4 Large function count
- Create a file with 100 small functions.
- Run pipeline.
- Verify all 100 functions have CFG data in the graph.
- Verify performance: pipeline completes in <30s (adjust threshold for CI).

#### 4.5 Graph queryability
- After indexing, query the graph for:
  - All unreachable blocks: `graph.forEachNode(n => n.label === 'BasicBlock' && n.properties.isUnreachable)`
  - All Jump edges: `graph.forEachRelationship(r => r.type === 'CFG_EDGE' && r.cfgEdgeType === 'Jump')`
  - Blocks belonging to a specific function: follow `CFG_CONTAINS` from function node
- Verify results match expectations from the fixture files.

#### 4.6 Regression — existing data unaffected
- Index a project with CFG enabled.
- Verify all non-CFG data (CALLS edges, IMPORTS, MEMBER_OF, communities, processes) is identical to a baseline index run without CFG.
- This guards against the CFG pass accidentally corrupting tree-sitter parsing or the resolution pipeline.

### Test Fixtures

Create `gitnexus/test/fixtures/cfg/` with reusable source files:

| Fixture | Contents | Tests |
|---------|----------|-------|
| `branching.ts` | Function with if/else, switch, ternary, loops, try/catch | 1.2–1.5, 1.10, 4.1 |
| `nested-functions.ts` | Top-level + class + arrow + named inner functions | 1.6, 1.7, 2.2, 4.1 |
| `edge-cases.ts` | Empty function, unreachable code, early returns, async | 1.8, 1.9, 1.12, 1.13 |
| `plain.js` | JavaScript without type annotations | 1.14 |
| `parse-error.ts` | Valid + broken + valid functions | 1.15 |
| `large.ts` | Generated: 500 functions with if/else | 1.16, 4.4 |
