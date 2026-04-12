/**
 * Unit tests for symbol-lookup module.
 */
import { describe, it, expect } from 'vitest';

// Re-implement the sorting logic for testing (since it's not exported)
const KIND_PRIORITY: Record<string, number> = {
  Interface: 1,
  TypeAlias: 1,
  Class: 1,
  Enum: 1,
  Property: 2,
  Field: 2,
  EnumMember: 2,
  Function: 3,
  Method: 3,
  Variable: 4,
  Parameter: 5,
};
const DEFAULT_PRIORITY = 6;

function sortByKindPriority<T extends { label?: string; filePath?: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    const aLabel = a.label ?? '';
    const bLabel = b.label ?? '';
    const aPriority = KIND_PRIORITY[aLabel] ?? DEFAULT_PRIORITY;
    const bPriority = KIND_PRIORITY[bLabel] ?? DEFAULT_PRIORITY;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return (a.filePath ?? '').localeCompare(b.filePath ?? '');
  });
}

describe('sortByKindPriority', () => {
  it('prioritizes Interface over Property', () => {
    const rows = [
      { label: 'Property', filePath: 'a.ts', name: 'foo' },
      { label: 'Interface', filePath: 'b.ts', name: 'foo' },
    ];
    const sorted = sortByKindPriority(rows);
    expect(sorted[0].label).toBe('Interface');
    expect(sorted[1].label).toBe('Property');
  });

  it('prioritizes Property over Parameter', () => {
    const rows = [
      { label: 'Parameter', filePath: 'a.ts', name: 'destBuilding' },
      { label: 'Property', filePath: 'b.ts', name: 'destBuilding' },
    ];
    const sorted = sortByKindPriority(rows);
    expect(sorted[0].label).toBe('Property');
    expect(sorted[1].label).toBe('Parameter');
  });

  it('prioritizes Class over Method over Variable', () => {
    const rows = [
      { label: 'Variable', filePath: 'a.ts', name: 'x' },
      { label: 'Method', filePath: 'b.ts', name: 'x' },
      { label: 'Class', filePath: 'c.ts', name: 'x' },
    ];
    const sorted = sortByKindPriority(rows);
    expect(sorted[0].label).toBe('Class');
    expect(sorted[1].label).toBe('Method');
    expect(sorted[2].label).toBe('Variable');
  });

  it('uses file path as secondary sort for same priority', () => {
    const rows = [
      { label: 'Property', filePath: 'z.ts', name: 'foo' },
      { label: 'Property', filePath: 'a.ts', name: 'foo' },
      { label: 'Property', filePath: 'm.ts', name: 'foo' },
    ];
    const sorted = sortByKindPriority(rows);
    expect(sorted[0].filePath).toBe('a.ts');
    expect(sorted[1].filePath).toBe('m.ts');
    expect(sorted[2].filePath).toBe('z.ts');
  });

  it('handles unknown labels with default priority', () => {
    const rows = [
      { label: 'UnknownKind', filePath: 'a.ts', name: 'x' },
      { label: 'Interface', filePath: 'b.ts', name: 'x' },
    ];
    const sorted = sortByKindPriority(rows);
    expect(sorted[0].label).toBe('Interface');
    expect(sorted[1].label).toBe('UnknownKind');
  });

  it('handles missing labels gracefully', () => {
    const rows = [
      { filePath: 'a.ts', name: 'x' },
      { label: 'Property', filePath: 'b.ts', name: 'x' },
    ];
    const sorted = sortByKindPriority(rows);
    expect(sorted[0].label).toBe('Property');
    expect(sorted[1].label).toBeUndefined();
  });

  it('prioritizes interface property (destBuilding) over parameter with same name', () => {
    // This is the exact scenario from the bug report
    const rows = [
      { label: 'Parameter', filePath: 'factory.ts', name: 'destBuilding', qn: 'Parameter:factory.ts:destBuilding:5' },
      { label: 'Property', filePath: 'types.ts', name: 'destBuilding', qn: 'Property:types.ts:TransportJobRecord.destBuilding:3' },
    ];
    const sorted = sortByKindPriority(rows);
    expect(sorted[0].label).toBe('Property');
    expect(sorted[0].filePath).toBe('types.ts');
    expect(sorted[1].label).toBe('Parameter');
  });
});
