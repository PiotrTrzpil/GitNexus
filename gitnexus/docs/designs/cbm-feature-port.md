# CBM Feature Port — Design

## Overview

Port 6 features from codebase-memory-mcp (Go/SQLite) to GitNexus (TypeScript/KuzuDB): incremental indexing, background file watching, cross-service HTTP route discovery, semantic diff, commit planning, and git change coupling. These fill GitNexus's key gaps in indexing efficiency, change analysis, and cross-service awareness.

## Summary for Review

- **Interpretation**: Build 6 new subsystems in GitNexus, porting algorithms from codebase-memory-mcp. Where possible, translate the Go logic 1:1 to TypeScript rather than redesigning. The HTTP route discovery is the largest piece; the rest are moderate-to-small.
- **Key decisions**:
  - Incremental indexing uses xxHash content hashing (not mtime) for correctness
  - File watcher runs as a background loop inside the MCP server process (not a separate daemon)
  - Semantic diff reuses GitNexus's existing tree-sitter extractors to build `Definition` objects (no new parser needed)
  - HTTP route discovery adds a new `HTTP_CALLS` relation type + `Route` node table to KuzuDB
  - Git change coupling stored as `FILE_CHANGES_WITH` relation type on File nodes
  - Commit planning is a pure MCP tool (no graph storage, computes on-the-fly from diff + graph)
- **Assumptions**:
  - KuzuDB schema can be extended with new node/relation types without migration (drop+recreate on re-analyze is acceptable)
  - `xxhash-wasm` npm package is acceptable (no native compilation needed)
  - File watcher only runs in MCP server mode (not CLI analyze)
- **Scope**: All 6 features. Deferred: OpenTelemetry trace ingestion, ADR management, adaptive worker pool concurrency tuning.

## Conventions

- Files use kebab-case: `semantic-diff.ts`, `file-watcher.ts`
- TypeScript ES2022 + NodeNext, async/await everywhere
- `strict: false` in tsconfig — pragmatic typing with `any` for tree-sitter AST nodes
- Error handling: throw for failures, `console.warn` for non-fatal, silent catch for optional features
- MCP tools defined in `src/mcp/tools.ts` array, dispatched via `LocalBackend.callTool()` switch
- Graph nodes/edges go through the in-memory `KnowledgeGraph` during pipeline, then bulk-loaded to KuzuDB
- Git operations via `child_process.execSync` (see `src/storage/git.ts`)

## Architecture

### Subsystems

| # | Subsystem | Responsibility | Depends On | Files |
|---|-----------|---------------|------------|-------|
| 1 | Incremental Indexing | Content-hash tracking, file classification, dependent file discovery | — | `src/core/ingestion/incremental.ts`, `src/storage/file-hashes.ts` |
| 2 | File Watcher | Adaptive polling, auto-reindex trigger | 1 | `src/core/watcher/file-watcher.ts` |
| 3 | HTTP Route Discovery | Framework-specific route extraction, cross-service URL matching, confidence scoring | — | `src/core/ingestion/http-linker.ts`, `src/core/ingestion/http-patterns.ts`, `src/core/ingestion/http-similarity.ts` |
| 4 | Semantic Diff | AST-level old/new comparison, breaking change classification | — | `src/core/diff/semantic-differ.ts`, `src/core/diff/breaking-changes.ts`, `src/core/diff/types.ts` |
| 5 | Commit Planning | Group coupled changes into logical commits via union-find | 4 | `src/core/diff/commit-planner.ts` |
| 6 | Git Change Coupling | Mine git history for co-change edges | — | `src/core/ingestion/git-coupling.ts` |

## Shared Contracts

```typescript
// ─── src/core/diff/types.ts ─────────────────────────────────────────

export type ChangeKind = 'Added' | 'Removed' | 'Renamed' | 'SignatureChanged' | 'VisibilityChanged' | 'BodyChanged';

export interface Definition {
  qualifiedName: string;
  name: string;
  label: string;            // 'Function' | 'Class' | 'Method' | 'Interface' | ...
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  paramTypes: string[];
  returnType: string;
  isExported: boolean;
  decorators: string[];
  baseClasses: string[];
  lines: number;
}

export interface FieldDelta {
  field: string;             // 'param_types' | 'return_type' | 'is_exported' | 'signature' | 'decorators' | 'base_classes'
  old: string;
  new: string;
}

export interface SymbolChange {
  kind: ChangeKind;
  label: string;
  name: string;
  qualifiedName: string;
  oldQualifiedName?: string; // for renames
  filePath: string;
  deltas: FieldDelta[];
  isBreaking: boolean;
}

export interface CommitGroup {
  scope: string;             // e.g. 'auth', 'pipeline', filename
  draftMessage: string;
  reason: string;            // 'coupled: X calls Y' | 'test + source' | 'same file'
  files: string[];
  changes: SymbolChange[];
}

export interface CommitPlan {
  groups: CommitGroup[];
  ungrouped: SymbolChange[];
}

// ─── src/core/ingestion/incremental.ts (exported types) ─────────────

export interface FileHash {
  relPath: string;
  hash: string;              // xxHash hex string
}

export interface FileClassification {
  changed: string[];         // paths to re-parse
  unchanged: string[];       // paths to skip
  dependent: string[];       // unchanged files that import changed modules
}

// ─── src/core/ingestion/http-linker.ts (exported types) ──────────────

export interface RouteHandler {
  path: string;              // '/api/users/:id'
  method: string;            // 'GET' | 'POST' | '' (any)
  functionName: string;
  qualifiedName: string;
  protocol: string;          // 'ws' | 'sse' | ''
  framework: string;         // 'express' | 'fastapi' | 'gin' | ...
}

export interface HTTPLink {
  sourceQN: string;          // caller function
  targetQN: string;          // route handler
  urlPath: string;
  httpMethod: string;
  confidence: number;        // 0.0 – 1.0
}

// ─── src/core/ingestion/git-coupling.ts (exported types) ─────────────

export interface ChangeCoupling {
  fileA: string;
  fileB: string;
  coChangeCount: number;
  totalChangesA: number;
  totalChangesB: number;
  couplingScore: number;     // coChangeCount / min(totalChangesA, totalChangesB)
}

// ─── src/core/watcher/file-watcher.ts (exported types) ───────────────

export interface WatcherOptions {
  onReindex: (repoPath: string) => Promise<void>;
  gracePeriodMs?: number;    // default 5000
  maxIntervalMs?: number;    // default 60000
}
```

## Subsystem Details

### 1. Incremental Indexing

**Files**: `src/core/ingestion/incremental.ts`, `src/storage/file-hashes.ts`

**Port from**: `codebase-memory-mcp/internal/pipeline/pipeline.go` (classifyFiles, fileHash, findDependentFiles)

**Key decisions**:
- Use `xxhash-wasm` (pure WASM, no native compilation) for content hashing — fast enough at ~2GB/s
- Store file hashes in a JSON file at `.gitnexus/file-hashes.json` (not KuzuDB — avoids schema changes and survives DB rebuilds)
- Hash computation parallelized via `Promise.all` with concurrency limit (not worker threads — hashing is I/O bound)
- Dependent file discovery uses the existing `importCtx` suffix index from the pipeline

**Behavior**:
- `classifyFiles(repoPath, scannedFiles)`: loads stored hashes, computes current hashes, returns `FileClassification`
- `findDependentFiles(changed, unchanged, importCtx)`: for each unchanged file, check if any of its imports resolve to a changed module — if so, mark as dependent
- `saveFileHashes(storagePath, hashes)` / `loadFileHashes(storagePath)`: persist to `.gitnexus/file-hashes.json`
- On first index (no stored hashes): all files classified as changed (full index)

**Integration with pipeline.ts**:
- Insert classification step between Phase 1 (scan) and Phase 3 (parse)
- When incremental: filter `parseableScanned` to only changed + dependent files
- Structure phase (Phase 2) always runs on all files (it's fast, path-only)
- After successful index: save current hashes

### 2. File Watcher

**Files**: `src/core/watcher/file-watcher.ts`

**Port from**: `codebase-memory-mcp/internal/watcher/watcher.go` — translate the adaptive polling algorithm directly

**Key decisions**:
- Runs inside MCP server process as a `setInterval` loop (not `fs.watch` — too unreliable cross-platform)
- Adaptive interval: `Math.min(1000 + Math.floor(fileCount / 500) * 1000, maxIntervalMs)` — same formula as Go version
- Change detection via mtime + size snapshot (cheap, no hashing on poll)
- Uses `TryLock` pattern (boolean flag) to skip re-index if one is already running
- Grace period: 5s after start before first poll

**Behavior**:
- `startWatcher(repos: {path: string, fileCount: number}[], options: WatcherOptions)`: starts polling loop, returns `stopWatcher()` function
- On change detected: calls `options.onReindex(repoPath)` which triggers `gitnexus analyze` (or in-process pipeline re-run)
- Snapshot: `Map<string, {mtime: number, size: number}>` per repo

**Integration**:
- Start watcher in `startMCPServer()` (src/mcp/server.ts) after backend init
- Stop watcher on SIGINT/SIGTERM
- `onReindex` callback: re-run pipeline for changed repo, reload KuzuDB

### 3. HTTP Route Discovery

**Files**: `src/core/ingestion/http-linker.ts`, `src/core/ingestion/http-patterns.ts`, `src/core/ingestion/http-similarity.ts`

**Port from**: `codebase-memory-mcp/internal/httplink/` — port the 3-signal confidence scoring algorithm and framework patterns

**Key decisions**:
- Runs as a new pipeline phase after call resolution (between heritage and communities)
- Adds `Route` node table to KuzuDB schema (reuse `CODE_ELEMENT_BASE` pattern)
- Adds `HTTP_CALLS` as a new relation type in `CodeRelation` with extra properties: `urlPath STRING, httpMethod STRING`
- Framework route extraction reuses existing tree-sitter AST queries — extend `call-processor.ts` route extraction (already partially exists via `processRoutesFromExtracted`)
- Cross-service URL matching uses the confidence scoring algorithm from Go verbatim

**Algorithm** (from `httplink.go`):
1. Collect all `RouteHandler` objects from AST extraction (per-framework patterns)
2. Collect all HTTP call sites (fetch, axios, http.get, etc.) from the call graph
3. For each call site × route pair: compute `pathMatchScore` using:
   - Path normalization (`:id` → `*`, UUID → `*`, numeric → `*`)
   - Match type: exact (0.95), suffix (0.75), wildcard (0.55)
   - Refined by: `0.5 * jaccardSimilarity + 0.5 * depthFactor`
   - Source weight × method bonus
4. Filter by min confidence (default 0.25), keep top matches

**Similarity functions to port** (from `similarity.go`):
- `levenshteinDistance(a, b)` — standard edit distance
- `normalizedLevenshtein(a, b)` — `1.0 - dist / maxLen`
- `ngramOverlap(a, b, n)` — `intersection / min(|ngrams(a)|, |ngrams(b)|)`

**Framework patterns to port** (from `httplink.go`):
- Express/Fastify/Koa: `app.get|post|put|delete|patch(path, handler)`
- FastAPI/Flask/Django: `@app.get(path)` decorators
- Gin/Echo/Chi/Mux: `router.GET|POST(path, handler)`
- Spring: `@GetMapping|@PostMapping|@RequestMapping(path)`
- Actix: `web::resource(path).route(web::get().to(handler))`

GitNexus already has partial route extraction in `call-processor.ts` via `processRoutesFromExtracted`. Extend this rather than replacing it.

### 4. Semantic Diff

**Files**: `src/core/diff/semantic-differ.ts`, `src/core/diff/breaking-changes.ts`, `src/core/diff/types.ts`

**Port from**: `codebase-memory-mcp/internal/semdiff/` — port the 3-pass diff algorithm and breaking change classifier directly

**Key decisions**:
- Extract `Definition` objects from old/new file versions using GitNexus's existing tree-sitter extractors (not a new parser)
- Old version retrieved via `git show HEAD:path` (same as Go impl, see `internal/pipeline/gitshow.go`)
- New version read from disk
- The diff algorithm and breaking change classification are language-agnostic — port 1:1 from Go

**Algorithm** (from `differ.go`):
- Pass 1: Exact QN matching — compare matched pairs field-by-field
- Pass 2: Fuzzy rename detection — unmatched same-label defs, require 2 of 3: same param count, same return type, line count within ±50%
- Pass 3: Remaining unmatched → Added/Removed

**Breaking change rules** (from `breaking.go`):
- Breaking when: symbol was exported AND kind ∈ {Removed, Renamed, SignatureChanged, VisibilityChanged}
- Breaking fields: `param_types`, `return_type`, `is_exported`, `signature`, `decorators`, `base_classes`
- Not breaking: Added, BodyChanged, or gained export

**MCP tool**: `semantic_diff` — expose as new tool in `tools.ts` and `LocalBackend`

### 5. Commit Planning

**Files**: `src/core/diff/commit-planner.ts`

**Port from**: `codebase-memory-mcp/internal/semdiff/commitplan.go` — port the union-find grouping algorithm

**Key decisions**:
- Pure computation: takes `SymbolChange[]` + graph edges → returns `CommitPlan`
- Union-find with 3 coupling signals (same as Go): graph edges, file co-location, test-source pairing
- Test file pattern matching (from `commitplan.go`): `_test.go`, `test_*.py`, `.test.ts`, `.spec.ts`, `_spec.rb`
- Draft commit message generation: priority-based verb selection, 80-char truncation
- Scope derivation: most specific common directory component

**MCP tool**: `plan_commits` — expose as new tool

### 6. Git Change Coupling

**Files**: `src/core/ingestion/git-coupling.ts`

**Port from**: `codebase-memory-mcp/internal/pipeline/githistory.go` — port the co-change counting algorithm

**Key decisions**:
- Runs as new pipeline phase after communities (before processes)
- Parses `git log --name-only --pretty=format:COMMIT:%H --since="6 months ago"`
- Thresholds (same as Go): skip commits with >20 files, require coChangeCount ≥ 3, couplingScore ≥ 0.3
- Top 100 couplings by score
- Stored as `FILE_CHANGES_WITH` relation type on `CodeRelation` edges between File nodes
- Edge properties: reuse existing `confidence` (= couplingScore), `reason` (= `"co-change:{count}/{totalA},{totalB}"`)
- Skip prefixes: `.git/`, `node_modules/`, `vendor/`, `__pycache__/`
- Skip names: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- Skip suffixes: `.lock`, `.sum`, `.min.js`, `.min.css`, `.map`, `.wasm`, `.png`

**Algorithm** (from `githistory.go`):
1. Parse git log → `{hash, files[]}[]`
2. For each commit with ≤20 files: for each file pair, increment co-change count
3. Compute `couplingScore = coChangeCount / min(totalChangesA, totalChangesB)`
4. Filter by thresholds, sort descending, take top 100
5. Store as File→File edges with type `FILE_CHANGES_WITH`

## PiotrTrzpil Commits to Migrate

Recent commits in codebase-memory-mcp that contain features/improvements not yet in GitNexus:

| Commit | Feature | Migration Notes |
|--------|---------|-----------------|
| `400ff6f` feat(semdiff) | AST-level semantic diff + breaking changes | **Core of Subsystem 4** — port differ.go, breaking.go, types.go |
| `422eb0a` feat(tools): semantic_diff | MCP tool for semantic diff with filtering, commit range, summary modes | **Subsystem 4 MCP tool** — port semantic_diff.go tool handler |
| `2c706dd` feat(tools): plan_commits | LLM-optimized commit planning tool | **Core of Subsystem 5** — port commitplan.go, plan_commits.go |
| `1e6dacb` feat(tools): trace improvements | Class hints, dead code diagnostics, file-grouped output in trace/search tools | **Enhance existing tools** — port trace.go improvements (file-grouped output, dead code hints) |
| `1343a32` feat(cypher): UNWIND clause | JSON array expansion in Cypher | **Not applicable** — GitNexus uses KuzuDB's native Cypher (full-featured) |
| `3d15f3f` feat(tools): YAML output | Compact YAML output format, enhanced CLI summaries | **Consider adopting** — YAML output is more token-efficient than JSON for MCP responses |
| `5ba0e22` feat(store): architecture boundaries | Cross-package call analysis, cluster naming, router case migration | **Partially applicable** — cluster naming heuristics could improve GitNexus community labels |
| `f29eb9d` feat(cbm): first string arg extraction | Extract first string arg from calls, param-type edges | **Useful for HTTP detection** — first-arg extraction helps identify URL literals in fetch/axios calls |
| `c96e731` feat(cypher): label aliases, arithmetic | Cypher enhancements, IMPLEMENTS edge fix | **Not applicable** — KuzuDB handles these natively |

**Priority migration order**: 400ff6f → 2c706dd → 422eb0a → 1e6dacb → f29eb9d → 3d15f3f

## File Map

### New Files

| File | Subsystem | Purpose |
|------|-----------|---------|
| `src/core/ingestion/incremental.ts` | 1 | File classification via content hashing |
| `src/storage/file-hashes.ts` | 1 | Persist/load file hashes to `.gitnexus/file-hashes.json` |
| `src/core/watcher/file-watcher.ts` | 2 | Adaptive filesystem polling loop |
| `src/core/ingestion/http-linker.ts` | 3 | Cross-service HTTP route matching engine |
| `src/core/ingestion/http-patterns.ts` | 3 | Per-framework route extraction patterns |
| `src/core/ingestion/http-similarity.ts` | 3 | Levenshtein, n-gram, Jaccard similarity functions |
| `src/core/diff/types.ts` | 4 | Shared types: Definition, SymbolChange, CommitGroup, etc. |
| `src/core/diff/semantic-differ.ts` | 4 | 3-pass AST diff algorithm |
| `src/core/diff/breaking-changes.ts` | 4 | Breaking change classification |
| `src/core/diff/commit-planner.ts` | 5 | Union-find grouping + draft message generation |
| `src/core/ingestion/git-coupling.ts` | 6 | Git history co-change analysis |

### Modified Files

| File | Change |
|------|--------|
| `src/core/ingestion/pipeline.ts` | Add incremental classification step (before parse), HTTP linking phase (after heritage), git coupling phase (after communities) |
| `src/core/kuzu/schema.ts` | Add `Route` node table, `FILE_CHANGES_WITH` + `HTTP_CALLS` to `REL_TYPES`, extend `RELATION_SCHEMA` with new FROM/TO pairs |
| `src/mcp/tools.ts` | Add `semantic_diff` and `plan_commits` tool definitions |
| `src/mcp/local/local-backend.ts` | Add `semanticDiff()` and `planCommits()` handlers in `callTool()` switch |
| `src/mcp/server.ts` | Start/stop file watcher in `startMCPServer()` |
| `src/storage/git.ts` | Add `gitShow(repoPath, ref, filePath)` and `gitLogNameOnly(repoPath, since)` helpers |
| `src/storage/repo-manager.ts` | Include file hash path in storage paths |

## Reference: Source Files to Port From

All paths relative to `/Users/subuser/Code/codebase-memory-mcp/`:

| Feature | Source File | Lines | Key Functions to Port |
|---------|------------|-------|----------------------|
| Incremental | `internal/pipeline/pipeline.go` | ~100 | `classifyFiles()`, `fileHash()`, `findDependentFiles()` |
| Watcher | `internal/watcher/watcher.go` | 218 | `Run()`, `pollSession()`, `captureSnapshot()`, `pollInterval()` |
| HTTP Linker | `internal/httplink/httplink.go` | 1,814 | `Run()`, `matchAndLink()`, `pathMatchScore()` |
| HTTP Similarity | `internal/httplink/similarity.go` | 98 | `levenshteinDistance()`, `normalizedLevenshtein()`, `ngramOverlap()` |
| HTTP Config | `internal/httplink/config.go` | 91 | `LoadConfig()`, `EffectiveMinConfidence()` |
| Semantic Diff | `internal/semdiff/differ.go` | 461 | `Diff()`, `compareDefinitions()`, `isFuzzyMatch()` |
| Breaking Changes | `internal/semdiff/breaking.go` | 119 | `ClassifyBreaking()`, `wasExported()`, `hasBreakingDelta()` |
| Commit Planning | `internal/semdiff/commitplan.go` | 593 | `PlanCommits()`, `buildCommitGroup()`, `deriveScope()`, `buildDraftMsg()` |
| Git Coupling | `internal/pipeline/githistory.go` | 226 | `passGitHistory()`, `computeChangeCoupling()`, `parseGitLog()` |

## Verification

1. **Incremental indexing**: Index a repo, modify one file, re-analyze — only the modified file (and its importers) should be re-parsed. Second run should be >3x faster than first.
2. **File watcher**: Start MCP server, modify a file in the indexed repo, verify the graph auto-updates within the adaptive interval.
3. **HTTP route discovery**: Index a repo with Express routes + fetch calls to those routes — verify `HTTP_CALLS` edges with confidence > 0.5 appear in Cypher queries.
4. **Semantic diff**: Modify a function signature, run `semantic_diff` — verify it reports `SignatureChanged` with `isBreaking: true` and correct field deltas.
5. **Commit planning**: Stage changes across 3 files (2 coupled via CALLS, 1 test), run `plan_commits` — verify 2 groups (coupled source + test in one, independent file separate).
6. **Git change coupling**: Index a repo with >3 months of history, query `FILE_CHANGES_WITH` edges — verify top couplings match `git log` inspection.
