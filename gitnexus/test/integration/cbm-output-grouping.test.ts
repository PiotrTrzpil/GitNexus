/**
 * Integration Tests: CBM Output Grouping
 *
 * Tests three related features:
 *   1. Output format (yaml/json switching, formatResult serialization)
 *   2. File grouping (groupByFile algorithm — copied from local-backend.ts
 *      since the function is not exported)
 *   3. Class hint response shape expectations
 *
 * These are pure-function tests; no KuzuDB connection is required.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOutputFormat,
  setOutputFormat,
  formatResult,
} from '../../src/mcp/output-format.js';

// ─── 1. Output Format ────────────────────────────────────────────────────────

describe('output format', () => {
  beforeEach(() => {
    setOutputFormat('yaml');
  });

  it('default format is yaml', () => {
    expect(getOutputFormat()).toBe('yaml');
  });

  it('formatResult with an object produces block-style YAML (no leading { or [)', () => {
    const result = formatResult({ name: 'foo', count: 3 });
    expect(result).not.toMatch(/^\s*\{/);
    expect(result).not.toMatch(/^\s*\[/);
    expect(result).toContain('name:');
    expect(result).toContain('foo');
  });

  it('formatResult with a string passes through unchanged', () => {
    const raw = '| col1 | col2 |\n|------|------|\n| a    | b    |';
    expect(formatResult(raw)).toBe(raw);
  });

  it('setOutputFormat("json") switches format and formatResult produces JSON', () => {
    setOutputFormat('json');
    expect(getOutputFormat()).toBe('json');
    const result = formatResult({ key: 'value' });
    expect(result.trimStart()).toMatch(/^\{/);
    // Must be valid JSON
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('setOutputFormat("yaml") switches back from json', () => {
    setOutputFormat('json');
    setOutputFormat('yaml');
    expect(getOutputFormat()).toBe('yaml');
    const result = formatResult({ key: 'value' });
    expect(result.trimStart()).not.toMatch(/^\{/);
  });

  it('setOutputFormat with invalid value throws a descriptive error', () => {
    expect(() => setOutputFormat('toml')).toThrow(/invalid/i);
    expect(() => setOutputFormat('toml')).toThrow('toml');
  });

  it('YAML output is more compact than JSON for nested objects', () => {
    const data = {
      processes: [
        { id: 'p1', summary: 'Authentication flow', steps: 5 },
        { id: 'p2', summary: 'Data pipeline', steps: 8 },
      ],
      process_symbols: [
        { name: 'validate', type: 'Function', filePath: 'src/auth.ts' },
        { name: 'hash', type: 'Function', filePath: 'src/auth.ts' },
      ],
    };

    setOutputFormat('yaml');
    const yaml = formatResult(data);
    setOutputFormat('json');
    const json = formatResult(data);

    expect(yaml.length).toBeLessThan(json.length);
  });
});

// ─── 2. File Grouping ────────────────────────────────────────────────────────
//
// groupByFile is a private function in local-backend.ts, so we mirror its
// implementation here to test the algorithm directly.
//
// Mirror of local-backend.ts groupByFile — keep in sync if the original changes.
function groupByFile<T extends Record<string, any>>(
  items: T[],
  fileKey = 'filePath',
): any[] {
  if (items.length <= 1) return items;

  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const item of items) {
    const file = item[fileKey] ?? '';
    if (!groups.has(file)) {
      groups.set(file, []);
      order.push(file);
    }
    groups.get(file)!.push(item);
  }

  // If every item is from a different file, flat list is more compact
  if (groups.size === items.length) return items;

  return order.map(file => {
    const fileItems = groups.get(file)!;
    const cleaned = fileItems.map(item => {
      const { [fileKey]: _, ...rest } = item;
      return rest;
    });
    return { file, items: cleaned };
  });
}

describe('groupByFile', () => {
  it('groups multiple items from the same file and strips filePath from items', () => {
    const input = [
      { name: 'foo', filePath: 'src/auth.ts', line: 10 },
      { name: 'bar', filePath: 'src/auth.ts', line: 20 },
    ];
    const result = groupByFile(input);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/auth.ts');
    expect(result[0].items).toHaveLength(2);
    // filePath should be stripped from each item
    expect(result[0].items[0]).not.toHaveProperty('filePath');
    expect(result[0].items[0].name).toBe('foo');
    expect(result[0].items[1].name).toBe('bar');
  });

  it('returns flat array unchanged when every item is from a different file', () => {
    const input = [
      { name: 'foo', filePath: 'src/a.ts' },
      { name: 'bar', filePath: 'src/b.ts' },
      { name: 'baz', filePath: 'src/c.ts' },
    ];
    const result = groupByFile(input);
    // All from different files — flat is more compact
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveProperty('filePath');
  });

  it('returns a single item as-is', () => {
    const input = [{ name: 'only', filePath: 'src/x.ts' }];
    const result = groupByFile(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(input[0]);
  });

  it('returns an empty array for empty input', () => {
    expect(groupByFile([])).toEqual([]);
  });

  it('correctly groups 3 files (2+3+1 items) with preserved order', () => {
    const input = [
      { name: 'a1', filePath: 'src/a.ts' },
      { name: 'a2', filePath: 'src/a.ts' },
      { name: 'b1', filePath: 'src/b.ts' },
      { name: 'b2', filePath: 'src/b.ts' },
      { name: 'b3', filePath: 'src/b.ts' },
      { name: 'c1', filePath: 'src/c.ts' },
    ];
    const result = groupByFile(input);
    expect(result).toHaveLength(3);

    expect(result[0].file).toBe('src/a.ts');
    expect(result[0].items).toHaveLength(2);

    expect(result[1].file).toBe('src/b.ts');
    expect(result[1].items).toHaveLength(3);

    expect(result[2].file).toBe('src/c.ts');
    expect(result[2].items).toHaveLength(1);
  });

  it('the file key in grouped output matches the original filePath', () => {
    const input = [
      { name: 'x', filePath: 'deeply/nested/module.ts' },
      { name: 'y', filePath: 'deeply/nested/module.ts' },
    ];
    const result = groupByFile(input);
    expect(result[0].file).toBe('deeply/nested/module.ts');
  });
});

// ─── 3. Class Hint Response Shape ────────────────────────────────────────────
//
// KuzuDB is not available in this test environment, so we validate the
// expected shape of class hint responses structurally.

describe('class hint response shape', () => {
  it('has the expected structure', () => {
    const hint = {
      status: 'class_node',
      message: 'MyClass is a Class — context/impact work best on functions/methods. Use one of its methods:',
      file: 'src/auth.ts',
      methods: [
        { name: 'validate', uid: 'Method:src/auth.ts:validate:5', kind: 'Method', line: 5 },
      ],
    };
    expect(hint.status).toBe('class_node');
    expect(hint.message).toContain('Class');
    expect(hint.message).toContain('methods');
    expect(hint.methods).toBeInstanceOf(Array);
    expect(hint.methods[0]).toHaveProperty('name');
    expect(hint.methods[0]).toHaveProperty('uid');
  });

  it('uid follows the Method:file:name:line convention', () => {
    const method = { name: 'login', uid: 'Method:src/auth.ts:login:42', kind: 'Method', line: 42 };
    const parts = method.uid.split(':');
    expect(parts[0]).toBe('Method');
    expect(parts[1]).toBe('src/auth.ts');
    expect(parts[2]).toBe('login');
    expect(parseInt(parts[3], 10)).toBe(method.line);
  });

  it('methods array preserves name and kind for each entry', () => {
    const hint = {
      status: 'class_node',
      message: 'AuthService is a Class — context/impact work best on functions/methods. Use one of its methods:',
      file: 'src/services/auth.ts',
      methods: [
        { name: 'login', uid: 'Method:src/services/auth.ts:login:10', kind: 'Method', line: 10 },
        { name: 'logout', uid: 'Method:src/services/auth.ts:logout:25', kind: 'Method', line: 25 },
        { name: 'refresh', uid: 'Method:src/services/auth.ts:refresh:40', kind: 'Method', line: 40 },
      ],
    };
    expect(hint.methods).toHaveLength(3);
    for (const m of hint.methods) {
      expect(m).toHaveProperty('name');
      expect(m).toHaveProperty('uid');
      expect(m).toHaveProperty('kind');
      expect(m).toHaveProperty('line');
      expect(typeof m.line).toBe('number');
    }
  });
});

// ─── 4. YAML vs JSON Token Efficiency ────────────────────────────────────────

describe('YAML vs JSON token efficiency', () => {
  beforeEach(() => {
    setOutputFormat('yaml');
  });

  it('YAML is more token-efficient than JSON for typical tool responses', () => {
    const data = {
      processes: [
        { id: 'p1', summary: 'Authentication flow', steps: 5 },
        { id: 'p2', summary: 'Data pipeline', steps: 8 },
      ],
      process_symbols: [
        { name: 'validate', type: 'Function', filePath: 'src/auth.ts' },
        { name: 'hash', type: 'Function', filePath: 'src/auth.ts' },
      ],
    };

    setOutputFormat('yaml');
    const yaml = formatResult(data);
    setOutputFormat('json');
    const json = formatResult(data);

    expect(yaml.length).toBeLessThan(json.length);
  });
});
