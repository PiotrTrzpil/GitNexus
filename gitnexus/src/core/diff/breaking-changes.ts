/**
 * breaking-changes.ts
 *
 * Breaking change classification for semantic diffs.
 *
 * Port of codebase-memory-mcp/internal/semdiff/breaking.go — translated 1:1 to
 * TypeScript.
 *
 * Rules (all must hold for a change to be breaking):
 *   1. Symbol was exported in the old version
 *   2. Kind ∈ { Removed, Renamed, SignatureChanged, VisibilityChanged }
 *   3. For SignatureChanged specifically: at least one delta touches a
 *      structurally significant field (not just complexity / line-count)
 *
 * BodyChanged and Added are NEVER breaking.
 * Gaining export (unexported → exported) is NEVER breaking — it is additive.
 */

import type { Definition, FieldDelta, SymbolChange } from './types.js';

// ---------------------------------------------------------------------------
// Breaking signature delta fields
// ---------------------------------------------------------------------------

/**
 * Field names that, when changed, constitute a breaking signature change.
 * Changes to `lines` alone are NOT breaking (implementation detail only).
 */
const BREAKING_SIGNATURE_DELTA_FIELDS = new Set<string>([
  'param_types',
  'return_type',
  'is_exported',
  'signature',
  'decorators',
  'base_classes',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Annotate `isBreaking` on each SymbolChange in-place and return the subset of
 * changes that are breaking.
 *
 * @param changes  - Mutable array of SymbolChange objects (from diff())
 * @param oldDefs  - Map of qualifiedName → Definition for the old file version
 * @param newDefs  - Map of qualifiedName → Definition for the new file version
 * @returns        - The subset of changes where isBreaking === true
 */
export function classifyBreaking(
  changes: SymbolChange[],
  oldDefs: Map<string, Definition>,
  newDefs: Map<string, Definition>,
): SymbolChange[] {
  const breaking: SymbolChange[] = [];

  for (const change of changes) {
    switch (change.kind) {
      case 'Added':
        // Additive changes are never breaking
        change.isBreaking = false;
        break;

      case 'BodyChanged':
        // Implementation-only change; callers are unaffected
        change.isBreaking = false;
        break;

      case 'Removed':
        // A removed exported symbol is always breaking
        if (wasExported(change, oldDefs)) {
          change.isBreaking = true;
        }
        break;

      case 'Renamed':
        // Renaming an exported symbol breaks callers referencing the old name
        if (wasExported(change, oldDefs)) {
          change.isBreaking = true;
        }
        break;

      case 'SignatureChanged':
        // Only breaking when the old symbol was exported AND at least one
        // structurally significant field changed (not just line count).
        if (wasExported(change, oldDefs) && hasBreakingDelta(change.deltas)) {
          change.isBreaking = true;
        }
        break;

      case 'VisibilityChanged':
        // Breaking only when the symbol was previously exported and is now
        // unexported. Gaining export (unexported → exported) is additive.
        if (wasExported(change, oldDefs) && !isNowExported(change, newDefs)) {
          change.isBreaking = true;
        }
        break;
    }

    if (change.isBreaking) {
      breaking.push(change);
    }
  }

  return breaking;
}

/**
 * Convenience wrapper: classify breaking changes for a diff result and return
 * the annotated full list. Builds the oldDefs / newDefs maps from arrays.
 *
 * @param changes  - SymbolChange[] from diff()
 * @param oldDefs  - Definition[] for the old file version
 * @param newDefs  - Definition[] for the new file version
 * @returns        - The same changes array, with isBreaking annotated in-place
 */
export function annotateBreaking(
  changes: SymbolChange[],
  oldDefs: Definition[],
  newDefs: Definition[],
): SymbolChange[] {
  const oldMap = new Map<string, Definition>(oldDefs.map(d => [d.qualifiedName, d]));
  const newMap = new Map<string, Definition>(newDefs.map(d => [d.qualifiedName, d]));
  classifyBreaking(changes, oldMap, newMap);
  return changes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Report whether the symbol was exported in the old version.
 *
 * Lookup order:
 *   1. Direct qualifiedName lookup in oldDefs
 *   2. For renames: oldQualifiedName lookup
 *   3. Last resort: inspect the is_exported delta (old value)
 *
 * Returns false (conservative) when no information is available.
 */
function wasExported(
  change: SymbolChange,
  oldDefs: Map<string, Definition>,
): boolean {
  const direct = oldDefs.get(change.qualifiedName);
  if (direct) return direct.isExported;

  // For renames, the old QN differs from the new one
  if (change.oldQualifiedName) {
    const byOldQN = oldDefs.get(change.oldQualifiedName);
    if (byOldQN) return byOldQN.isExported;
  }

  // Last resort: inspect the is_exported delta and use the old value
  for (const d of change.deltas) {
    if (d.field === 'is_exported') {
      return d.old === 'true';
    }
  }

  // No information — conservative: treat as non-exported (not breaking)
  return false;
}

/**
 * Report whether the symbol is exported in the new version.
 */
function isNowExported(
  change: SymbolChange,
  newDefs: Map<string, Definition>,
): boolean {
  const direct = newDefs.get(change.qualifiedName);
  if (direct) return direct.isExported;

  // Check the is_exported delta for the new value
  for (const d of change.deltas) {
    if (d.field === 'is_exported') {
      return d.new === 'true';
    }
  }

  return false;
}

/**
 * Report whether any delta in the slice touches a structurally significant
 * field (as opposed to a cosmetic / complexity-only change).
 */
function hasBreakingDelta(deltas: FieldDelta[]): boolean {
  return deltas.some(d => BREAKING_SIGNATURE_DELTA_FIELDS.has(d.field));
}
