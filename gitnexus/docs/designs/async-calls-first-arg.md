# Async Calls & First-Arg Extraction — Design

## Overview

Port two tightly coupled features from codebase-memory-mcp to GitNexus: (1) `ASYNC_CALLS` edge type for cross-service async dispatch detection, and (2) `firstArg` property on CALLS edges to capture event/topic names. Together these enable pub/sub topology analysis, event-channel discovery, and async impact analysis.

## Summary for Review

- **Interpretation**: Wire the existing `isAsync` detection (already ported in `http-patterns.ts`) through the HTTP linker to emit `ASYNC_CALLS` edges. Separately, extend call-edge creation to capture the first string-literal argument at each call site.
- **Key decisions**:
  - `ASYNC_CALLS` is a new `RelationshipType` — same schema as `HTTP_CALLS`, just a different type string
  - `firstArg` stored as a JSON array string in the `reason` field suffix (e.g., `reason: "import-resolved|args:["topic"]"`) since adding a KuzuDB column requires schema migration. This keeps it queryable via `CONTAINS` in Cypher.
  - Impact analysis, context queries, and trace traversal updated to include `HTTP_CALLS` and `ASYNC_CALLS`
  - `firstArg` extraction happens in the existing call-processor during call resolution — no new pipeline phase
- **Assumptions**:
  - Existing `ASYNC_DISPATCH_KEYWORDS` list in `http-patterns.ts` is sufficient (already matches Go version)
  - `firstArg` extraction from tree-sitter AST uses the existing `call_expression` / `arguments` node structure
  - Adding `ASYNC_CALLS` to `REL_TYPES` is safe since KuzuDB `CodeRelation.type` is a `STRING` column
- **Scope**: ASYNC_CALLS edge type + firstArg extraction + tool traversal updates. Deferred: dedicated `Topic`/`Event` node types, broker topology modeling, subscriber-side edge creation.

## Conventions

Same as the main project — see CLAUDE.md and the CBM feature port design doc.

## Architecture

### Subsystems

| # | Subsystem | Responsibility | Depends On | Files |
|---|-----------|---------------|------------|-------|
| 1 | ASYNC_CALLS Edge Emission | Propagate `isAsync` through HTTPLink, emit ASYNC_CALLS edges | — | `src/core/ingestion/http-linker.ts` |
| 2 | First-Arg Extraction | Extract first string literal from call-site arguments in tree-sitter AST | — | `src/core/ingestion/call-processor.ts` |
| 3 | Schema & Types | Add ASYNC_CALLS to RelationshipType, REL_TYPES, VALID_RELATION_TYPES | — | `src/core/graph/types.ts`, `src/core/kuzu/schema.ts` |
| 4 | Tool Traversal Updates | Include HTTP_CALLS + ASYNC_CALLS in impact, context, and trace queries | 3 | `src/mcp/local/local-backend.ts` |

## Shared Contracts

No new shared type files needed. Changes are to existing interfaces:

```typescript
// ─── src/core/ingestion/http-linker.ts (modify HTTPLink) ────────────
// Add:
export interface HTTPLink {
  sourceQN: string;
  targetQN: string;
  urlPath: string;
  httpMethod: string;
  confidence: number;
  isAsync: boolean;        // NEW — true for async dispatch, false for sync HTTP
}

// ─── src/core/graph/types.ts (extend RelationshipType) ──────────────
// Add '| ASYNC_CALLS' to the union

// ─── src/mcp/local/local-backend.ts (extend VALID_RELATION_TYPES) ───
// Add 'HTTP_CALLS' and 'ASYNC_CALLS' to the Set
```

## Subsystem Details

### 1. ASYNC_CALLS Edge Emission

**Files**: `src/core/ingestion/http-linker.ts`

**What to change**:
- Add `isAsync: boolean` field to `HTTPLink` interface
- In `matchAndLink()`: the `HTTPCallSite` already carries `isAsync`. Pass it through to the returned `HTTPLink`.
- In `HTTPLinker.writeEdges()`: check `link.isAsync` to decide edge type:
  ```typescript
  type: link.isAsync ? 'ASYNC_CALLS' : 'HTTP_CALLS',
  ```
  Also update the reason string to include `async:` prefix for async edges:
  ```typescript
  reason: `${link.isAsync ? 'async' : 'http'}:${link.httpMethod || 'ANY'}:${band}`,
  ```
- Remove the `as any` cast on the type now that `HTTP_CALLS` is already in the union

**Port from**: `codebase-memory-mcp/internal/httplink/httplink.go` lines 1268–1272 (the `if cs.IsAsync` branch)

### 2. First-Arg Extraction

**Files**: `src/core/ingestion/call-processor.ts`

**What to change**:
- In the call resolution loop where `graph.addRelationship({ type: 'CALLS', ... })` is called, extract the first string-literal argument from the call site's AST node
- The tree-sitter `call_expression` node has an `arguments` child. Walk into `arguments`, find the first child that is a `string` / `template_string` / `string_literal` node, extract its text (strip quotes)
- Append the extracted arg to the `reason` field: `reason: "${resolved.reason}|arg:${firstArg}"`
- If no string literal first arg, leave reason unchanged

**Algorithm**:
```typescript
function extractFirstStringArg(callNode: Parser.SyntaxNode): string {
  const args = callNode.childForFieldName('arguments');
  if (!args) return '';
  for (const child of args.namedChildren) {
    if (child.type === 'string' || child.type === 'string_fragment' ||
        child.type === 'template_string' || child.type === 'string_literal' ||
        child.type === 'interpreted_string_literal') {
      // Strip quotes
      let text = child.text;
      if ((text.startsWith('"') && text.endsWith('"')) ||
          (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1);
      }
      if (text.startsWith('`') && text.endsWith('`')) {
        text = text.slice(1, -1);
      }
      return text;
    }
  }
  return '';
}
```

**Integration**: The call processor already has access to AST nodes during call resolution. The `processCallsFromExtracted` function receives extracted call info. We need to check if the AST node is still available at that point — if not, we extract during the AST walk phase and store on the extracted call data.

**Port from**: `codebase-memory-mcp/internal/cbm/cbm.go` — the `FirstArg` field on `Call` struct, populated by the C extractor.

### 3. Schema & Types

**Files**: `src/core/graph/types.ts`, `src/core/kuzu/schema.ts`, `src/mcp/local/local-backend.ts`

**What to change in `types.ts`**:
- Add `| 'ASYNC_CALLS'` to `RelationshipType` union (already has `HTTP_CALLS` and `FILE_CHANGES_WITH`)

**What to change in `schema.ts`**:
- Add `'ASYNC_CALLS'` to `REL_TYPES` array

**What to change in `local-backend.ts`**:
- Add `'HTTP_CALLS'` and `'ASYNC_CALLS'` to `VALID_RELATION_TYPES` Set

### 4. Tool Traversal Updates

**Files**: `src/mcp/local/local-backend.ts`

**What to change**:

**`context()` method** (~line 1018–1031): Update the hardcoded edge type arrays in both caller and callee queries:
```typescript
// Before:
WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
// After:
WHERE r.type IN ['CALLS', 'HTTP_CALLS', 'ASYNC_CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
```

**`impact()` method**: Already uses `VALID_RELATION_TYPES` for filtering — adding `HTTP_CALLS` and `ASYNC_CALLS` to that set automatically includes them.

**`hasCrossService` flag**: Add cross-service detection to the impact result:
```typescript
// In the impact result builder, check if any traversed edge is HTTP_CALLS or ASYNC_CALLS
const hasCrossService = edges.some(e => e.type === 'HTTP_CALLS' || e.type === 'ASYNC_CALLS');
```

**Port from**:
- `codebase-memory-mcp/internal/store/edges.go` — `NodeNeighborNames` includes all 3 types
- `codebase-memory-mcp/internal/store/impact.go` — `HasCrossService` flag
- `codebase-memory-mcp/internal/tools/trace.go` — BFS includes all 3 types

## File Map

### Modified Files

| File | Change |
|------|--------|
| `src/core/ingestion/http-linker.ts` | Add `isAsync` to HTTPLink, emit ASYNC_CALLS vs HTTP_CALLS based on flag, update reason prefix |
| `src/core/ingestion/call-processor.ts` | Extract first string-literal arg from call AST node, append to edge reason |
| `src/core/graph/types.ts` | Add `'ASYNC_CALLS'` to RelationshipType union |
| `src/core/kuzu/schema.ts` | Add `'ASYNC_CALLS'` to REL_TYPES |
| `src/mcp/local/local-backend.ts` | Add HTTP_CALLS + ASYNC_CALLS to VALID_RELATION_TYPES, update context() queries, add hasCrossService to impact results |

### No New Files

All changes are modifications to existing files.

## Verification

1. **ASYNC_CALLS edges**: Index a repo with Kafka producer calls + Express routes → verify `ASYNC_CALLS` edges appear in Cypher queries with correct confidence
2. **First-arg extraction**: Index a repo with `bus.emit("user.created")` → verify CALLS edge reason contains `|arg:user.created`
3. **Impact traversal**: Run `impact` on a function that is only reachable via ASYNC_CALLS → verify it appears in the blast radius
4. **Context query**: Run `context` on a route handler called via async dispatch → verify the async caller appears
5. **Cross-service flag**: Run `impact` on a function with ASYNC_CALLS edges → verify `hasCrossService: true` in result
