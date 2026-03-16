# New Tools & Context Lines — Design

## Overview

Port 3 new MCP tools (`get_code_snippet`, `search_code`, `search_graph`) from codebase-memory-mcp, add an expanded `get_architecture` tool, and enhance existing tool results with disk-fresh source code + surrounding context lines.

## Summary for Review

- **Interpretation**: Add 4 new tools + enhance 2 existing tools. All new tools go in `local-backend.ts` following the existing pattern (tool def in `tools.ts`, case in `callTool`, private method).
- **Key decisions**:
  - `get_code_snippet` reads fresh source from disk (not stale graph `n.content`), formats with line numbers
  - `search_code` operates on the indexed file set (from File nodes in KuzuDB), not arbitrary filesystem
  - `search_graph` translates structured params into Cypher — no custom query engine needed (KuzuDB handles it)
  - `get_architecture` runs aspect-specific Cypher queries and assembles results
  - Context lines helper is a shared utility: reads file from disk, returns line-numbered slice with surrounding context
- **Scope**: 4 new tools + context-line enhancement on `query()` and `impact()`. Deferred: ingest_traces, manage_adr, adaptive worker pool.

## Conventions

- Files use kebab-case, imports use `.js` extensions
- `strict: false` in tsconfig — pragmatic typing
- Tools: definition in `tools.ts`, dispatch in `callTool()` switch, private method on `LocalBackend`
- KuzuDB: `executeParameterized(repo.id, cypher, params)` for safe queries
- File reads: `fs.readFile(path, 'utf-8')` with `assertSafePath()` for safety
- Error handling: `logQueryError()` + catch for non-fatal, throw for fatal

## Architecture

### Subsystems

| # | Subsystem | Responsibility | Depends On | Files |
|---|-----------|---------------|------------|-------|
| 1 | Source Reader | Read file from disk, format with line numbers + context lines | — | `src/mcp/source-reader.ts` (NEW) |
| 2 | get_code_snippet | 4-tier symbol resolution, source from disk, neighbor counts | 1 | `src/mcp/local/local-backend.ts` |
| 3 | search_code | Text/regex search across indexed files with context | 1 | `src/mcp/local/local-backend.ts` |
| 4 | search_graph | Structured graph node search with degree/label/pattern filters | — | `src/mcp/local/local-backend.ts` |
| 5 | get_architecture | Multi-aspect architecture view via Cypher queries | — | `src/mcp/local/local-backend.ts` |
| 6 | Context enhancement | Add disk-fresh source + context lines to query/impact results | 1 | `src/mcp/local/local-backend.ts` |
| 7 | Tool definitions | Tool schemas for all 4 new tools | — | `src/mcp/tools.ts` |

## Shared Contracts

```typescript
// ─── src/mcp/source-reader.ts (NEW) ────────────────────────────────

/** Read a file from disk and return line-numbered source for a range with context. */
export function readSourceWithContext(
  repoPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
  contextLines?: number,  // default 3
): Promise<{ source: string; firstLine: number; lastLine: number } | null>;

/**
 * Format source lines with line numbers.
 * Output: "  42 | func foo() {"
 */
export function formatWithLineNumbers(
  lines: string[],
  startLine: number,
): string;
```

## Subsystem Details

### 1. Source Reader

**Files**: `src/mcp/source-reader.ts` (NEW)

Shared utility for all tools that need disk-fresh source code with context lines.

**Key decisions**:
- Reads from disk (not graph `n.content`) for freshness
- Path safety: `path.resolve(repoPath, filePath)` — reject if result is outside repoPath (path traversal guard)
- Line number format: `"  42 | code here"` — right-aligned line numbers, pipe separator (matches CBM format)
- Context: reads `[startLine - contextLines, endLine + contextLines]`, clamped to file bounds
- Returns `null` if file not found (ENOENT) — callers fall back to graph content

### 2. get_code_snippet

**Files**: `src/mcp/local/local-backend.ts` (add `private async getCodeSnippet()`)

**Key decisions**:
- 4-tier QN resolution via Cypher:
  1. Exact: `WHERE n.id = $qn`
  2. Suffix: `WHERE n.id ENDS WITH $suffix`
  3. Name: `WHERE n.name = $name`
  4. Fuzzy: return suggestions (no auto-resolve — KuzuDB doesn't have fuzzy search, return top-10 name matches)
- Each tier tried in order, stop on first result
- Source read via `readSourceWithContext()` with caller-specified `context_lines`
- Neighbor counts: two Cypher queries for inbound/outbound CALLS edge count
- Optional `include_neighbors`: also return caller/callee name lists (not just counts)

**Return shape**:
```typescript
{
  name: string; qn: string; label: string; file: string;
  lines: string; // "42-67"
  source: string; // line-numbered
  signature?: string;
  callers: number; callees: number;
  caller_names?: string[]; callee_names?: string[];
  match_method: 'exact_qn' | 'qn_suffix' | 'name' | 'suggestions';
  alternatives?: { name: string; qn: string; label: string; file: string }[];
}
```

### 3. search_code

**Files**: `src/mcp/local/local-backend.ts` (add `private async searchCode()`)

**Key decisions**:
- Get indexed file list from KuzuDB: `MATCH (f:File) RETURN f.filePath`
- Filter by `file_pattern` glob (use `minimatch` or simple string matching)
- Read each file from disk, scan line-by-line for pattern matches
- `regex: true` → `new RegExp(pattern, flags)`, `false` → `string.includes()`
- Concurrency: process files sequentially (I/O bound, not CPU bound)
- Two-pass: count total matches first (lightweight scan), then fetch page with context
- Context lines: read surrounding lines via array slice (file already in memory)
- Cap: `max_results` default 20, hard cap 100
- Return `has_more` + `total_matches` for pagination

**Return shape**:
```typescript
{
  pattern: string; total_matches: number;
  limit: number; offset: number; has_more: boolean;
  matches: Array<{
    file: string; line: number;
    content: string; // matched line, trimmed, max 200 chars
    context?: string[]; // surrounding lines with line numbers
  }>;
}
```

### 4. search_graph

**Files**: `src/mcp/local/local-backend.ts` (add `private async searchGraph()`)

**Key decisions**:
- Translates structured params into a single Cypher query with WHERE clauses
- `name_pattern` → `WHERE n.name =~ $pattern` (KuzuDB regex)
- `label` → node label filter in MATCH clause
- `file_pattern` → `WHERE n.filePath CONTAINS $filePattern`
- Degree filtering: subquery `MATCH (x)-[r:CodeRelation]->(n)` with COUNT for inbound, similar for outbound
- `sort_by`: `degree` → ORDER BY (in+out) DESC, `name` → ORDER BY n.name
- `exclude_labels` default `['Community', 'Process', 'Folder']` — skip infrastructure nodes
- Pagination via SKIP/LIMIT

**Return shape**:
```typescript
{
  total: number;
  results: Array<{
    name: string; qn: string; label: string; file: string;
    lines: string; // "42-67"
    in_degree: number; out_degree: number;
  }>;
  has_more: boolean;
}
```

### 5. get_architecture

**Files**: `src/mcp/local/local-backend.ts` (add `private async getArchitecture()`)

**Key decisions**:
- `aspects` param: array of strings, default `['all']`
- Each aspect is a separate Cypher query, assembled into the response
- Aspects:
  - `languages` — `MATCH (f:File) RETURN f.language, COUNT(f)` grouped
  - `packages` — top-level directories with file/symbol counts
  - `entry_points` — nodes with `isEntryPoint = true` or high entry-point score
  - `routes` — `MATCH (n:Route)` or nodes with HTTP route properties
  - `hotspots` — functions with highest fan-in (most callers)
  - `boundaries` — cross-community CALLS edges (community A → community B)
  - `services` — HTTP_CALLS + ASYNC_CALLS grouped by source/target community
  - `clusters` — existing community data (reuse overview query)
- Each aspect returns its own key in the response, `null`/omitted if not requested

### 6. Context Enhancement

**Files**: `src/mcp/local/local-backend.ts` (modify `query()` and `impact()`)

**Key decisions**:
- `query()`: when `include_content: true`, use `readSourceWithContext()` instead of graph `n.content`. Adds `source` field (line-numbered) alongside existing `content` field.
- `impact()`: add `include_content` param. When true, for each item in `byDepth`, read source from disk with 2 context lines. Cap at depth 1 items only (direct dependents) to avoid excessive I/O.
- Both fall back to graph `n.content` if disk read returns null.

### 7. Tool Definitions

**Files**: `src/mcp/tools.ts`

Add 4 tool definitions to `GITNEXUS_TOOLS` array:

- `get_code_snippet`: params `qualified_name` (required), `context_lines`, `include_neighbors`, `repo`
- `search_code`: params `pattern` (required), `file_pattern`, `max_results`, `offset`, `context_lines`, `regex`, `case_sensitive`, `repo`
- `search_graph`: params `name_pattern`, `label`, `file_pattern`, `min_degree`, `max_degree`, `direction`, `sort_by`, `limit`, `exclude_labels`, `repo`
- `get_architecture`: params `aspects`, `repo`

## File Map

### New Files

| File | Subsystem | Purpose |
|------|-----------|---------|
| `src/mcp/source-reader.ts` | 1 | Shared utility: read file from disk with line numbers + context |

### Modified Files

| File | Change |
|------|--------|
| `src/mcp/tools.ts` | Add 4 tool definitions |
| `src/mcp/local/local-backend.ts` | Add 4 private methods + callTool cases, enhance query/impact with context lines |

## Verification

1. **get_code_snippet**: Call with a function name → verify line-numbered source from disk, correct callers/callees counts, `match_method` field
2. **search_code**: Search for a string literal in the indexed repo → verify matches with correct line numbers and context lines
3. **search_graph**: Search for `name_pattern: ".*Handler.*"` with `label: "Function"` → verify filtered results with degree counts
4. **get_architecture**: Call with `aspects: ["languages", "hotspots"]` → verify language breakdown and top fan-in functions
5. **Context lines**: Call `query` with `include_content: true` → verify `source` field contains line-numbered disk-fresh code
