# Add startColumn / endColumn to Symbol Schema — Design

## Overview

Add 0-based `startColumn` and `endColumn` to every node type that has `startLine`/`endLine`. Tree-sitter already provides `node.startPosition.column` — we just capture, persist, and use it. Primary consumer: the rename tool, which can now target exact character positions instead of regex-matching on a line.

## Summary for Review

- **Interpretation**: add two INT64 columns to all ~20 node table schemas, populate them from tree-sitter's `.startPosition.column` / `.endPosition.column` in both the worker and sequential ingestion paths, include them in CSV generation, and wire them through to the rename tools.
- **Key decisions**: columns default to 0 for backwards compat (old indexes still work); rename tools use column when > 0, fall back to regex when 0. No schema migration — requires `gitnexus analyze` re-run.
- **Assumptions**: `startColumn` refers to the _name_ node's column (for rename targeting), not the definition node's column. The definition node's column is often 0 (start of line) and useless for rename. We store both: `startColumn` from the name node, `endColumn` from the definition node's end.
- **Scope**: schema + ingestion + CSV + graph types + rename tools. Does NOT change MCP response shapes or CLI output.

## Conventions

- All node properties use camelCase (`startColumn`, not `start_column`)
- CSV headers match property names exactly
- `escapeCSVNumber(value, defaultValue)` handles undefined/null
- Tree-sitter rows/columns are 0-based; the codebase stores them as-is (0-based)
- Schema uses `INT64` for all position fields

## Architecture

### Subsystems

| # | Subsystem | Responsibility | Depends On | Files |
|---|-----------|---------------|------------|-------|
| 1 | Schema & Types | Add columns to DB schema + TS types | — | `schema.ts`, `graph/types.ts` |
| 2 | Ingestion | Extract column from tree-sitter nodes | 1 | `parse-worker.ts`, `parsing-processor.ts`, `parameter-extraction.ts` |
| 3 | CSV Pipeline | Include columns in CSV headers + row data | 1 | `csv-generator.ts` |
| 4 | Rename Consumer | Use column for precise positioning | 1 | `ts-morph-rename.ts`, `rope-rename.ts`, `rope-rename.py`, `local-backend.ts` |

## Shared Contracts

```typescript
// graph/types.ts — add to NodeProperties
interface NodeProperties {
  // ... existing fields ...
  startLine?: number;    // 0-based
  endLine?: number;      // 0-based
  startColumn?: number;  // 0-based — NEW (column of the name node)
  endColumn?: number;    // 0-based — NEW (column of the definition node end)
}

// parameter-extraction.ts — add to ExtractedParameter and PromotedProperty
interface ExtractedParameter {
  // ... existing fields ...
  startColumn: number;  // NEW
  endColumn: number;    // NEW
}
interface PromotedProperty {
  // ... existing fields ...
  startColumn: number;  // NEW
  endColumn: number;    // NEW
}

// ts-morph-rename.ts — updated signature
function tsMorphRename(opts: {
  repoPath: string;
  filePath: string;
  line: number;
  column?: number;  // NEW — 0-based, skip regex when provided and > 0
  oldName: string;
  newName: string;
  dryRun: boolean;
}): Promise<TsMorphEdit[] | null>;

// rope-rename.ts — updated signature (same pattern)
function ropeRename(opts: {
  repoPath: string;
  filePath: string;
  line: number;
  column?: number;  // NEW — 0-based
  oldName: string;
  newName: string;
  dryRun: boolean;
}): Promise<RopeEdit[] | null>;

// rope-rename.py — input JSON gains optional "column" field
// { "repoPath": str, "filePath": str, "line": int, "column": int|null, ... }
```

## Subsystem Details

### 1. Schema & Types
**Files**: `src/core/lbug/schema.ts`, `src/core/graph/types.ts`

Add `startColumn INT64` and `endColumn INT64` immediately after `endLine INT64` in:
- `FUNCTION_SCHEMA`, `CLASS_SCHEMA`, `INTERFACE_SCHEMA` (explicit schemas)
- `METHOD_SCHEMA` (the one with the long column list)
- `CODE_ELEMENT_BASE(name)` helper — cascades to 16 types (Struct, Enum, Macro, Typedef, Union, Namespace, Trait, Impl, TypeAlias, Const, Static, Record, Delegate, Annotation, Template, Module)
- `ROUTE_SCHEMA`, `BASIC_BLOCK_SCHEMA`, `PARAMETER_SCHEMA`
- `PROPERTY_SCHEMA`, `CONSTRUCTOR_SCHEMA`

In `types.ts`, add `startColumn?: number` and `endColumn?: number` to `NodeProperties`.

### 2. Ingestion
**Files**: `src/core/ingestion/workers/parse-worker.ts`, `src/core/ingestion/parsing-processor.ts`, `src/core/ingestion/parameter-extraction.ts`
**Depends on**: 1

**Key decisions**:
- For `startColumn`, prefer the **name node's** column (`nameNode.startPosition.column`) — this is what the rename tool needs to position the cursor on the identifier. Fall back to definition node's column, then 0.
- For `endColumn`, use `definitionNode.endPosition.column` (consistent with `endLine`).

**parse-worker.ts** (~line 1678, alongside `nodeStartLine`/`nodeEndLine`):
```typescript
const nodeStartColumn = nameNode ? nameNode.startPosition.column : (definitionNode ? definitionNode.startPosition.column : 0);
const nodeEndColumn = definitionNode ? definitionNode.endPosition.column : (nameNode ? nameNode.endPosition.column : 0);
```
Add `startColumn: nodeStartColumn, endColumn: nodeEndColumn` to `result.nodes.push()` properties.

**parse-worker.ts** (Parameter/Property node pushes at ~1440 and ~1778):
Pass `startColumn`/`endColumn` from the extraction result objects.

**parsing-processor.ts** (~line 270): same pattern as parse-worker.

**parameter-extraction.ts** (~lines 303 and 394): add `startColumn: paramNode.startPosition.column, endColumn: paramNode.endPosition.column` alongside the existing `startLine`/`endLine`.

### 3. CSV Pipeline
**Files**: `src/core/lbug/csv-generator.ts`
**Depends on**: 1

Add `startColumn,endColumn` to every CSV header that has `startLine,endLine` — insert right after `endLine` in each header string:
- `codeElementHeader` (used by Class, Interface, CodeElement)
- `functionHeader`
- `methodHeader`
- `multiLangHeader` (16 types)
- `propertyHeader`
- `constructorHeader`
- `parameterHeader`
- `basicBlockHeader`

In each row write, insert `escapeCSVNumber(p.startColumn, 0), escapeCSVNumber(p.endColumn, 0)` right after the `endLine` value.

### 4. Rename Consumer
**Files**: `src/core/rename/ts-morph-rename.ts`, `src/core/rename/rope-rename.ts`, `scripts/rope-rename.py`, `src/mcp/local/local-backend.ts`
**Depends on**: 1

**ts-morph-rename.ts**: add optional `column?: number` to opts. When `column` is provided and `column > 0`, compute the absolute position directly (`lineStartPos + column`) and skip the regex search loop entirely. When column is 0 or undefined, use existing regex fallback.

**rope-rename.ts** + **rope-rename.py**: add optional `column` to input JSON. When provided, use it directly for the byte offset calculation instead of regex. In Python: `offset = line_start + column`.

**local-backend.ts**: when calling `tsMorphRename` or `ropeRename`, pass `column: sym.startColumn` from the graph symbol lookup. The rename helpers handle the 0/undefined fallback internally.

## File Map

### Modified Files
| File | Change |
|------|--------|
| `src/core/lbug/schema.ts` | Add `startColumn INT64, endColumn INT64` to all node schemas |
| `src/core/graph/types.ts` | Add `startColumn?: number, endColumn?: number` to `NodeProperties` |
| `src/core/ingestion/workers/parse-worker.ts` | Extract column from tree-sitter, pass to node properties |
| `src/core/ingestion/parsing-processor.ts` | Same as parse-worker (sequential fallback) |
| `src/core/ingestion/parameter-extraction.ts` | Add columns to `ExtractedParameter` and `PromotedProperty`, populate from tree-sitter |
| `src/core/lbug/csv-generator.ts` | Add columns to all CSV headers and row writes |
| `src/core/rename/ts-morph-rename.ts` | Accept optional `column`, use for precise positioning |
| `src/core/rename/rope-rename.ts` | Accept optional `column`, pass to Python script |
| `scripts/rope-rename.py` | Accept optional `column` in JSON input, use for offset |
| `src/mcp/local/local-backend.ts` | Pass `sym.startColumn` to rename helpers |

## Verification
1. `gitnexus analyze` on a TS repo → query `MATCH (f:Function) RETURN f.name, f.startColumn LIMIT 5` → columns are non-zero for indented functions
2. Rename a symbol where the same name appears in a comment before the identifier on the same line → should target the identifier, not the comment
3. Old index without columns → rename tool falls back to regex (no regression)
4. Parameter nodes have correct column values (indented inside function signatures)
