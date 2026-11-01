/**
 * Cyclomatic complexity and SLOC on real tree-sitter trees. Expected values are
 * hand-counted: complexity = 1 + decision points (if, loops, case, catch,
 * ternary, && / || / ??); nested callables are scored separately.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import C from 'tree-sitter-c';
import CSharp from 'tree-sitter-c-sharp';
import { computeCallableMetrics } from '../../src/core/ingestion/complexity.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

function parse(grammar: unknown, src: string): SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(grammar as Parameters<Parser['setLanguage']>[0]);
  return parser.parse(src).rootNode;
}

function first(node: SyntaxNode, type: string): SyntaxNode {
  const hit = find(node, type);
  if (!hit) throw new Error(`no ${type}`);
  return hit;
}

function find(node: SyntaxNode, type: string): SyntaxNode | undefined {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const hit = find(node.child(i)!, type);
    if (hit) return hit;
  }
  return undefined;
}

const metrics = (grammar: unknown, src: string, lang: SupportedLanguages, defType?: string) => {
  const root = parse(grammar, src);
  return computeCallableMetrics(defType ? first(root, defType) : root, lang);
};

describe('computeCallableMetrics: TypeScript', () => {
  const ts = (src: string, defType?: string) =>
    metrics(TypeScript.typescript, src, SupportedLanguages.TypeScript, defType);

  it('straight-line function is 1', () => {
    expect(ts('function f(a: number) {\n  return a + 1;\n}')).toEqual({ complexity: 1, sloc: 3 });
  });

  it('counts if / else-if / for / for-of / while / do / case / catch / ternary / && / || / ??', () => {
    const src = `function f(xs: number[], a: boolean, b: boolean) {
  if (a) {            // +1
    return 1;
  } else if (b) {     // +1
    return 2;
  }
  for (let i = 0; i < 3; i++) {}   // +1
  for (const x of xs) {}           // +1
  while (a) { break; }             // +1
  do { a = false; } while (a);     // +1
  switch (xs.length) {
    case 1: break;                 // +1
    case 2: break;                 // +1
    default: break;                // default does not count
  }
  try { g(); } catch (e) {}        // +1
  const t = a ? 1 : 2;             // +1
  const u = a && b || a;           // +2
  const v = xs[0] ?? 3;            // +1
  return t + u + v;
}`;
    expect(ts(src)!.complexity).toBe(1 + 13);
  });

  it('does not count bitwise or arithmetic binary operators', () => {
    expect(ts('function f(a: number, b: number) { return (a | b) + (a & b) + a * b; }')).toEqual({
      complexity: 1,
      sloc: 1,
    });
  });

  it('scores a nested closure separately from its parent', () => {
    const src = `function outer(a: boolean) {
  const inner = () => { if (a) { return 1; } return 2; };
  if (a) { return inner(); }
  return 0;
}`;
    expect(ts(src, 'function_declaration')!.complexity).toBe(2); // only the outer `if`
    expect(ts(src, 'arrow_function')!.complexity).toBe(2); // only the inner `if`
  });

  it('finds the arrow function behind a const declaration', () => {
    const src = 'export const f = (a: boolean) => {\n  return a ? 1 : 2;\n};';
    expect(ts(src, 'export_statement')).toEqual({ complexity: 2, sloc: 3 });
  });

  it('measures a class method and ignores comment and blank lines in sloc', () => {
    const src = `class C {
  m(a: boolean) {
    // a comment

    /* block
       comment */
    if (a) {
      return 1;
    }
    return 2;
  }
}`;
    expect(ts(src, 'method_definition')).toEqual({ complexity: 2, sloc: 6 });
  });

  it('returns undefined when the definition holds no callable', () => {
    expect(ts('const x = 1;', 'lexical_declaration')).toBeUndefined();
  });
});

describe('computeCallableMetrics: Python', () => {
  const py = (src: string) =>
    metrics(Python, src, SupportedLanguages.Python, 'function_definition');

  it('straight-line function is 1', () => {
    expect(py('def f(a):\n    return a\n')).toEqual({ complexity: 1, sloc: 2 });
  });

  it('counts if/elif/for/while/except/ternary/and/or/comprehension', () => {
    const src = `def f(xs, a, b):
    if a:                 # +1
        pass
    elif b:               # +1
        pass
    else:
        pass
    for x in xs:          # +1
        pass
    while a:              # +1
        break
    try:
        pass
    except ValueError:    # +1
        pass
    y = 1 if a else 2     # +1
    z = a and b or a      # +2
    w = [i for i in xs if i]   # +2 (for_in_clause, if_clause)
    return y
`;
    expect(py(src)!.complexity).toBe(1 + 10);
  });

  it('does not descend into a nested def', () => {
    const src = `def outer(a):
    def inner(b):
        if b:
            return 1
        return 2
    if a:
        return inner(a)
    return 0
`;
    expect(py(src)!.complexity).toBe(2);
  });
});

describe('computeCallableMetrics: other languages', () => {
  it('Java', () => {
    const src = `class A {
  int f(int x, boolean a, boolean b) {
    if (a && b) { x++; }          // +2
    for (int i = 0; i < x; i++) {}  // +1
    switch (x) { case 1: break; case 2: break; default: break; }  // +2
    try { x++; } catch (Exception e) {}  // +1
    return a ? 1 : 2;             // +1
  }
}`;
    expect(
      metrics(Java, src, SupportedLanguages.Java, 'method_declaration')!.complexity,
    ).toBe(1 + 7);
  });

  it('Go', () => {
    const src = `package p
func f(xs []int, a, b bool) int {
	if a || b { return 1 }   // +2
	for range xs {}          // +1
	switch len(xs) {
	case 1:                  // +1
	case 2:                  // +1
	default:
	}
	return 0
}`;
    expect(metrics(Go, src, SupportedLanguages.Go, 'function_declaration')!.complexity).toBe(1 + 5);
  });

  it('Rust', () => {
    const src = `fn f(a: bool, b: bool, o: Option<i32>) -> i32 {
    if a && b { return 1; }   // +2
    while a { break; }        // +1
    match o {
        Some(_) => 1,         // +1
        None => 2,            // +1
    }
}`;
    expect(metrics(Rust, src, SupportedLanguages.Rust, 'function_item')!.complexity).toBe(1 + 5);
  });

  it('C', () => {
    const src = `int f(int a, int b) {
  if (a || b) { return 1; }   // +2
  for (;;) { break; }         // +1
  while (a) { a--; }          // +1
  switch (a) { case 1: break; default: break; }  // +1
  return a ? 1 : 0;           // +1
}`;
    expect(metrics(C, src, SupportedLanguages.C, 'function_definition')!.complexity).toBe(1 + 6);
  });

  it('C#', () => {
    const src = `class A {
  int F(int x, bool a) {
    if (a && x > 0) { x++; }        // +2
    foreach (var i in new int[0]) {}  // +1
    try { x++; } catch (System.Exception) {}  // +1
    return a ? 1 : x;               // +1
  }
}`;
    expect(
      metrics(CSharp, src, SupportedLanguages.CSharp, 'method_declaration')!.complexity,
    ).toBe(1 + 5);
  });

  it('languages without rules yield undefined', () => {
    expect(
      metrics(Python, 'def f():\n    pass\n', SupportedLanguages.Ruby, 'function_definition'),
    ).toBeUndefined();
  });
});
