# MCP Tool Consolidation

## Current State (15 tools)

`list_repos`, `query`, `cypher`, `context`, `detect_changes`, `rename`, `impact`, `search_graph`, `search_code`, `semantic_diff`, `plan_commits`, `set_output_format`, `get_code_snippet`, `quality_query`, `get_architecture`

## Target State (9 tools + 6 new resources)

**Tools**: `list_repos`, `query`, `cypher`, `context`, `detect_changes`, `rename`, `impact`, `semantic_diff`, `quality_query`

**New resources**: `languages`, `packages`, `entry_points`, `routes`, `boundaries`, `services`

## Implementation Streams

Six independent work streams. No dependencies between them — can be done in any order or in parallel.

---

### Stream A: Merge `get_code_snippet` into `context`

**Files**: `local-backend.ts`, `tools.ts`

**Why**: `context` returns stale `n.content` from the graph. `get_code_snippet` reads live source from disk with context lines and 4-tier fuzzy lookup. They duplicate the symbol lookup logic (~80 lines each).

**Steps**:
1. Extract shared 4-tier lookup (exact QN → suffix → name → fuzzy) into a `findSymbol()` utility in a new file (e.g. `symbol-lookup.ts`)
2. Upgrade `context`'s `include_content` to read from disk via `readSourceWithContext` instead of returning graph `n.content`
3. Add `context_lines` param to `context` tool definition in `tools.ts`
4. Refactor `context` handler to use `findSymbol()`
5. Remove `get_code_snippet` tool definition from `tools.ts`, case from `callTool`, and `getCodeSnippet()` method

---

### Stream B: Merge `plan_commits` into `semantic_diff`

**Files**: `local-backend.ts`, `tools.ts`

**Why**: `plan_commits` calls semantic_diff internally then groups results via union-find. One tool can do both.

**Steps**:
1. Add `group_commits: boolean` param to `semantic_diff` tool definition in `tools.ts` (default: false)
2. When `group_commits` is true, run the existing union-find grouping logic after diffing and include commit groups in the response
3. Remove `plan_commits` tool definition from `tools.ts`, case from `callTool`, and handler method

---

### Stream C: Drop `set_output_format`

**Files**: `local-backend.ts`, `tools.ts`, `output-format.ts`

**Why**: MCP transport is JSON-RPC 2.0 — tool results are `CallToolResult` with `TextContent.text` strings. Over MCP, JSON is the natural format. YAML is only useful for human-readable CLI output. A session-config toggle doesn't belong in the tool list.

**Steps**:
1. Remove `set_output_format` tool definition from `tools.ts` and case from `callTool`
2. Hardcode JSON output for MCP server path
3. Keep YAML as default for CLI path (`npx gitnexus tool ...`)
4. Remove or simplify `output-format.ts` if no longer needed

---

### Stream D: Remove `search_code`

**Files**: `local-backend.ts`, `tools.ts`, `source-reader.ts`

**Why**: Duplicates `grep`/`rg` which respects `.gitignore` anyway. For remote MCP servers (no filesystem access), agents lose grep capability — acceptable trade-off, can re-add later.

**Steps**:
1. Remove `search_code` tool definition from `tools.ts` and case from `callTool`
2. Remove `searchCode()` method from `local-backend.ts`
3. Remove `readFileLines` and `formatWithLineNumbers` from `source-reader.ts` (only used by `searchCode`)
4. Keep `readSourceWithContext` — used by `context` (after Stream A), `query`, and `impact`

---

### Stream E: Remove `search_graph`, fold into `quality_query`

**Files**: `local-backend.ts`, `tools.ts`

**Why**: `search_graph` is a structured Cypher builder. Without degree filtering it's trivially done via `cypher`. With degree filtering it overlaps `quality_query` presets (`dead_code`, `god_functions`).

**Steps**:
1. Add new `quality_query` presets in `_runQualityPreset`:
   - `hotspots` — functions with highest inbound CALLS
   - `high_fan_out` — functions with highest outbound CALLS
   - `by_name` — find nodes matching a name regex + label filter
2. Add the new preset names to the `preset` enum in `tools.ts`
3. Remove `search_graph` tool definition from `tools.ts`, case from `callTool`, and `searchGraph()` method

---

### Stream F: Convert `get_architecture` to resources

**Status**: Considering (not yet approved)

**Files**: `local-backend.ts`, `tools.ts`, `resources.ts`

**Why**: Each aspect is a single cheap Cypher query. Per-aspect resources let agents cherry-pick without wasting tokens. MCP resource templates only support path params (RFC 6570), no query strings — so each aspect becomes its own resource.

**New resources** (following existing flat pattern):
```
gitnexus://repo/{name}/languages
gitnexus://repo/{name}/packages
gitnexus://repo/{name}/entry_points
gitnexus://repo/{name}/routes
gitnexus://repo/{name}/boundaries
gitnexus://repo/{name}/services
gitnexus://repo/{name}/clusters        ← already exists, deduplicate
```

`hotspots` omitted — covered by `quality_query` preset (Stream E).

**Steps**:
1. Add 6 resource templates to `resources.ts` with URI patterns
2. Move each aspect's Cypher query from `getArchitecture()` into resource handlers
3. Deduplicate `clusters` (already exists as a resource)
4. Remove `get_architecture` tool definition from `tools.ts`, case from `callTool`, and `getArchitecture()` method

**Trade-offs**:
- Lose batching (can't say "hotspots + boundaries in one call") — but each query is ~10ms so multiple reads are cheap
- Gain: agents read only what they need, better context efficiency, individually subscribable
