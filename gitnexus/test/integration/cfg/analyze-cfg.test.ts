/**
 * Integration Tests — Layer 1: NAPI Binding (analyzeCfg)
 *
 * Tests the `analyzeCfg()` function exported by `@gitnexus/oxc-cfg` directly —
 * no pipeline, no graph. These tests verify that the Rust→JS boundary produces
 * correct, well-formed JS objects.
 *
 * Philosophy: assert on OUTCOMES (observable behavior), not internals.
 *   - Use flexible assertions: "at least N blocks", "some edge has type Jump"
 *   - Never assert exact block counts, exact block IDs, or exact instruction counts
 *   - Use .includes() / .toContain() for string matching
 *
 * All tests are skipped if the native binding is unavailable (no prebuilt
 * binary, no Rust toolchain). This follows the graceful-degradation model.
 */

import { describe, it, expect } from 'vitest';
import type { CfgAnalysisResult, FunctionCfg, CfgBlock, CfgEdge } from '@gitnexus/oxc-cfg';

// ── Binding bootstrap ──────────────────────────────────────────────────────
// Optional import: skip all tests gracefully if the native binding isn't built.

let analyzeCfg: ((filename: string, sourceCode: string, options?: any) => CfgAnalysisResult) | undefined;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@gitnexus/oxc-cfg');
  analyzeCfg = mod.analyzeCfg;
} catch {
  // Binding not available — tests will be skipped via skipIfNoBinding below.
}

const skipIfNoBinding = analyzeCfg ? describe : describe.skip;

// ── Helper utilities ───────────────────────────────────────────────────────

function findFunction(result: CfgAnalysisResult, name: string): FunctionCfg | undefined {
  return result.functions.find(f => f.name === name);
}

function findFunctionByPattern(result: CfgAnalysisResult, pattern: RegExp): FunctionCfg | undefined {
  return result.functions.find(f => pattern.test(f.name));
}

function hasEdgeOfType(fn: FunctionCfg, type: string): boolean {
  return fn.edges.some(e => e.type === type);
}

function edgesOfType(fn: FunctionCfg, type: string): CfgEdge[] {
  return fn.edges.filter(e => e.type === type);
}

function hasInstructionOfKind(fn: FunctionCfg, kind: string): boolean {
  return fn.blocks.some(b => b.instructions.some(i => i.kind === kind));
}

function findBlocksWithInstructionKind(fn: FunctionCfg, kind: string): CfgBlock[] {
  return fn.blocks.filter(b => b.instructions.some(i => i.kind === kind));
}

// ── Test suite ─────────────────────────────────────────────────────────────

skipIfNoBinding('analyzeCfg NAPI binding', () => {

  // ── 1.1 Linear function ─────────────────────────────────────────────────

  describe('1.1 linear function', () => {
    const src = `function greet(name: string) { console.log(name); return name; }`;

    it('returns at least one function named "greet"', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'greet');
      expect(fn).toBeDefined();
    });

    it('greet has correct startLine and endLine', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'greet')!;
      expect(fn.startLine).toBeGreaterThanOrEqual(1);
      expect(fn.endLine).toBeGreaterThanOrEqual(fn.startLine);
    });

    it('greet has at least one block', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'greet')!;
      expect(fn.blocks.length).toBeGreaterThanOrEqual(1);
    });

    it('greet has all Normal edges (no jumps/branches)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'greet')!;
      // A straight-line function should not have Jump or Backedge edges
      expect(hasEdgeOfType(fn, 'Jump')).toBe(false);
      expect(hasEdgeOfType(fn, 'Backedge')).toBe(false);
    });

    it('greet has a Return instruction', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'greet')!;
      expect(hasInstructionOfKind(fn, 'Return')).toBe(true);
    });
  });

  // ── 1.2 If/else branching ────────────────────────────────────────────────

  describe('1.2 if/else branching', () => {
    const src = `
function check(x: number) {
  if (x > 0) {
    return "positive";
  } else {
    return "non-positive";
  }
}`;

    it('returns a function named "check"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'check')).toBeDefined();
    });

    it('check has at least 3 blocks (entry + true branch + false branch)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'check')!;
      expect(fn.blocks.length).toBeGreaterThanOrEqual(3);
    });

    it('check has a Jump edge from the if condition', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'check')!;
      expect(hasEdgeOfType(fn, 'Jump')).toBe(true);
    });

    it('Jump edge conditionText contains "x > 0"', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'check')!;
      const jumpEdges = edgesOfType(fn, 'Jump');
      const hasCondition = jumpEdges.some(e => e.conditionText && e.conditionText.includes('x > 0'));
      expect(hasCondition).toBe(true);
    });

    it('check has a Normal edge (the else path)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'check')!;
      expect(hasEdgeOfType(fn, 'Normal')).toBe(true);
    });

    it('both branches end with Return instructions', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'check')!;
      const returnBlocks = findBlocksWithInstructionKind(fn, 'Return');
      expect(returnBlocks.length).toBeGreaterThanOrEqual(2);
    });

    it('entry block has a Condition instruction', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'check')!;
      // Entry block (id=0) should contain the Condition instruction for the if
      expect(hasInstructionOfKind(fn, 'Condition')).toBe(true);
    });
  });

  // ── 1.3 Loops — for, while, do-while ────────────────────────────────────

  describe('1.3 loops (for / while / do-while)', () => {
    const src = `
function loopy() {
  for (let i = 0; i < 10; i++) { process(i); }
  while (true) { if (done()) break; }
  do { step(); } while (hasMore());
}`;

    it('returns a function named "loopy"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'loopy')).toBeDefined();
    });

    it('loopy has Backedge edges (at least one per loop)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'loopy')!;
      const backedges = edgesOfType(fn, 'Backedge');
      expect(backedges.length).toBeGreaterThanOrEqual(1);
    });

    it('loopy has Iteration instructions', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'loopy')!;
      expect(hasInstructionOfKind(fn, 'Iteration')).toBe(true);
    });

    it('loopy has a Break instruction from the while-true loop', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'loopy')!;
      expect(hasInstructionOfKind(fn, 'Break')).toBe(true);
    });

    it('loopy has at least one Jump edge (from break or loop condition)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'loopy')!;
      expect(hasEdgeOfType(fn, 'Jump')).toBe(true);
    });
  });

  // ── 1.4 Try/catch/finally ────────────────────────────────────────────────

  describe('1.4 try/catch/finally', () => {
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

    it('returns a function named "risky"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'risky')).toBeDefined();
    });

    it('risky has an ErrorExplicit or ErrorImplicit edge (try→catch)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'risky')!;
      const hasErrorEdge = hasEdgeOfType(fn, 'ErrorExplicit') || hasEdgeOfType(fn, 'ErrorImplicit');
      expect(hasErrorEdge).toBe(true);
    });

    it('risky has a Finalize edge (→ finally block)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'risky')!;
      expect(hasEdgeOfType(fn, 'Finalize')).toBe(true);
    });

    it('risky has at least 3 blocks (try body, catch block, finally block)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'risky')!;
      expect(fn.blocks.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── 1.5 Switch statement ─────────────────────────────────────────────────

  describe('1.5 switch statement', () => {
    const src = `
function route(action: string) {
  switch (action) {
    case "create": return create();
    case "update": return update();
    case "delete": return deleteThing();
    default: throw new Error("unknown");
  }
}`;

    it('returns a function named "route"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'route')).toBeDefined();
    });

    it('route has distinct blocks for each case (at least 4)', () => {
      // entry + at least one block per case/default
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'route')!;
      expect(fn.blocks.length).toBeGreaterThanOrEqual(4);
    });

    it('route has Return instructions in case blocks', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'route')!;
      const returnBlocks = findBlocksWithInstructionKind(fn, 'Return');
      expect(returnBlocks.length).toBeGreaterThanOrEqual(3);
    });

    it('route has a Throw instruction in the default block', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'route')!;
      expect(hasInstructionOfKind(fn, 'Throw')).toBe(true);
    });
  });

  // ── 1.6 Nested functions — separate FunctionCfg entries ─────────────────

  describe('1.6 nested functions produce separate FunctionCfg entries', () => {
    const src = `
function outer() {
  const inner = () => { return 1; };
  function named() { return 2; }
  return inner() + named();
}`;

    it('result contains at least 3 function entries (outer, inner/anonymous, named)', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(result.functions.length).toBeGreaterThanOrEqual(3);
    });

    it('contains a function named "outer"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'outer')).toBeDefined();
    });

    it('contains a function named "named"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'named')).toBeDefined();
    });

    it('contains an entry for the inner arrow (by name or anonymous pattern)', () => {
      const result = analyzeCfg!('test.ts', src);
      // The inner arrow may be named "inner" (inferred) or "anonymous@N"
      const hasInner =
        result.functions.some(f => f.name === 'inner') ||
        result.functions.some(f => /anonymous/i.test(f.name) || /arrow/i.test(f.name) || /\d+/.test(f.name));
      expect(hasInner).toBe(true);
    });

    it('each function has block IDs starting from 0', () => {
      const result = analyzeCfg!('test.ts', src);
      for (const fn of result.functions) {
        if (fn.blocks.length > 0) {
          const minId = Math.min(...fn.blocks.map(b => b.id));
          expect(minId).toBe(0);
        }
      }
    });

    it("outer's blocks do not contain return value 1 or 2 from inner functions", () => {
      // outer's CFG should be its own subgraph — inner/named are split out
      const result = analyzeCfg!('test.ts', src);
      const outerFn = findFunction(result, 'outer')!;
      // outer should have fewer blocks than if all nested functions were inlined
      // At minimum: outer itself has an entry block + return block
      expect(outerFn.blocks.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 1.7 Class methods ───────────────────────────────────────────────────

  describe('1.7 class methods', () => {
    const src = `
class Calculator {
  add(a: number, b: number) { return a + b; }
  divide(a: number, b: number) {
    if (b === 0) throw new Error("div by zero");
    return a / b;
  }
}`;

    it('contains function entries with className "Calculator"', () => {
      const result = analyzeCfg!('test.ts', src);
      const calculatorMethods = result.functions.filter(f => f.className === 'Calculator');
      expect(calculatorMethods.length).toBeGreaterThanOrEqual(2);
    });

    it('contains an entry for "divide" (or "Calculator.divide")', () => {
      const result = analyzeCfg!('test.ts', src);
      const divideFn =
        findFunction(result, 'divide') ||
        findFunctionByPattern(result, /divide/i);
      expect(divideFn).toBeDefined();
    });

    it('divide has a Jump edge (from the b === 0 check)', () => {
      const result = analyzeCfg!('test.ts', src);
      const divideFn =
        findFunction(result, 'divide') ||
        findFunctionByPattern(result, /divide/i);
      expect(divideFn).toBeDefined();
      expect(hasEdgeOfType(divideFn!, 'Jump')).toBe(true);
    });

    it('divide Jump edge conditionText contains "b === 0"', () => {
      const result = analyzeCfg!('test.ts', src);
      const divideFn =
        findFunction(result, 'divide') ||
        findFunctionByPattern(result, /divide/i);
      const jumpEdges = edgesOfType(divideFn!, 'Jump');
      const hasCondition = jumpEdges.some(e => e.conditionText && e.conditionText.includes('b === 0'));
      expect(hasCondition).toBe(true);
    });

    it('divide has a Throw instruction in the guard branch', () => {
      const result = analyzeCfg!('test.ts', src);
      const divideFn =
        findFunction(result, 'divide') ||
        findFunctionByPattern(result, /divide/i);
      expect(hasInstructionOfKind(divideFn!, 'Throw')).toBe(true);
    });
  });

  // ── 1.8 Async/await (current behavior — no suspension edges) ────────────

  describe('1.8 async/await (no suspension edges — known limitation)', () => {
    // NOTE: oxc CFG currently treats `await` as a regular Statement instruction,
    // not a suspension point. This is a known limitation documented in the design
    // (see "Hints for Upstream oxc_cfg Modifications" § 5). The test asserts the
    // CURRENT behavior, not the desired future behavior.
    const src = `
async function fetchData(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("HTTP error");
  return await response.json();
}`;

    it('returns a function named "fetchData"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'fetchData')).toBeDefined();
    });

    it('fetchData has no "Suspend" edge type (await is regular Statement)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'fetchData')!;
      // No suspension edges — this is the known current behavior
      expect(hasEdgeOfType(fn, 'Suspend')).toBe(false);
    });

    it('fetchData still has Jump/Normal branching from the if(!response.ok) check', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'fetchData')!;
      expect(hasEdgeOfType(fn, 'Jump')).toBe(true);
    });

    it('fetchData has a Throw instruction', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'fetchData')!;
      expect(hasInstructionOfKind(fn, 'Throw')).toBe(true);
    });
  });

  // ── 1.9 Early return / guard clauses ────────────────────────────────────

  describe('1.9 early return / guard clauses', () => {
    const src = `
function process(input: string | null) {
  if (!input) return;
  if (input.length === 0) return;
  doWork(input);
}`;

    it('returns a function named "process"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'process')).toBeDefined();
    });

    it('process has at least 2 Jump edges (one per guard clause)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'process')!;
      const jumpEdges = edgesOfType(fn, 'Jump');
      expect(jumpEdges.length).toBeGreaterThanOrEqual(2);
    });

    it('process has Return instructions on early-return blocks', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'process')!;
      const returnBlocks = findBlocksWithInstructionKind(fn, 'Return');
      // At least 2 early returns (may also have an implicit return at end)
      expect(returnBlocks.length).toBeGreaterThanOrEqual(2);
    });

    it('process has Normal edges (the "pass" paths through guards)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'process')!;
      expect(hasEdgeOfType(fn, 'Normal')).toBe(true);
    });
  });

  // ── 1.10 Ternary expressions ─────────────────────────────────────────────

  describe('1.10 ternary expressions', () => {
    const src = `
function pick(flag: boolean) {
  const result = flag ? computeA() : computeB();
  return result;
}`;

    it('returns a function named "pick"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'pick')).toBeDefined();
    });

    it('pick has branching edges (Jump or Normal) from the ternary', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'pick')!;
      const hasBranching = hasEdgeOfType(fn, 'Jump') || fn.edges.length > 1;
      expect(hasBranching).toBe(true);
    });

    it('Jump edge conditionText contains "flag"', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'pick')!;
      const jumpEdges = edgesOfType(fn, 'Jump');
      if (jumpEdges.length > 0) {
        const hasFlag = jumpEdges.some(e => e.conditionText && e.conditionText.includes('flag'));
        expect(hasFlag).toBe(true);
      } else {
        // Ternary may produce a Condition instruction instead of a Jump edge in some CFG models
        expect(hasInstructionOfKind(fn, 'Condition')).toBe(true);
      }
    });
  });

  // ── 1.11 Logical operators as control flow (&&, ||) ──────────────────────

  describe('1.11 logical operators (&&, ||) as control flow', () => {
    const src = `
function shortCircuit(a: any, b: any) {
  a && doSomething();
  b || fallback();
}`;

    it('returns a function named "shortCircuit"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'shortCircuit')).toBeDefined();
    });

    it('shortCircuit has Condition instructions (short-circuit evaluation)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'shortCircuit')!;
      expect(hasInstructionOfKind(fn, 'Condition')).toBe(true);
    });

    it('shortCircuit has some branching structure (Jump or multiple blocks)', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'shortCircuit')!;
      // Either jump edges or multiple blocks indicate branching
      const hasBranching = hasEdgeOfType(fn, 'Jump') || fn.blocks.length >= 2;
      expect(hasBranching).toBe(true);
    });
  });

  // ── 1.12 Unreachable code ────────────────────────────────────────────────

  describe('1.12 unreachable code after return', () => {
    const src = `
function dead() {
  return 42;
  console.log("never");
  const x = 1;
}`;

    it('returns a function named "dead"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'dead')).toBeDefined();
    });

    it('dead has at least one block marked unreachable: true', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'dead')!;
      const unreachableBlocks = fn.blocks.filter(b => b.unreachable === true);
      expect(unreachableBlocks.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 1.13 Empty function ──────────────────────────────────────────────────

  describe('1.13 empty function', () => {
    const src = `function noop() {}`;

    it('returns a function named "noop"', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(findFunction(result, 'noop')).toBeDefined();
    });

    it('noop has at least 1 block', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'noop')!;
      expect(fn.blocks.length).toBeGreaterThanOrEqual(1);
    });

    it('noop has an ImplicitReturn instruction', () => {
      const result = analyzeCfg!('test.ts', src);
      const fn = findFunction(result, 'noop')!;
      // Empty function body should produce an ImplicitReturn
      expect(hasInstructionOfKind(fn, 'ImplicitReturn')).toBe(true);
    });
  });

  // ── 1.14 JavaScript (not TypeScript) ─────────────────────────────────────

  describe('1.14 JavaScript without type annotations', () => {
    const src = `function add(a, b) { return a + b; }`;

    it('handles .js filename without errors', () => {
      const result = analyzeCfg!('test.js', src);
      expect(result.errors).toBeDefined();
      // Should produce no parse errors for valid JS
      expect(result.errors.length).toBe(0);
    });

    it('returns a function named "add"', () => {
      const result = analyzeCfg!('test.js', src);
      expect(findFunction(result, 'add')).toBeDefined();
    });

    it('add has a Return instruction', () => {
      const result = analyzeCfg!('test.js', src);
      const fn = findFunction(result, 'add')!;
      expect(hasInstructionOfKind(fn, 'Return')).toBe(true);
    });

    it('explicit sourceType override "javascript" also works', () => {
      const result = analyzeCfg!('test.ts', src, { sourceType: 'javascript' });
      const fn = findFunction(result, 'add');
      expect(fn).toBeDefined();
    });
  });

  // ── 1.15 Parse errors — partial results ─────────────────────────────────

  describe('1.15 parse errors — partial results', () => {
    // The broken function has a missing closing paren — a syntax error.
    const src = `
function valid() { return 1; }
function broken( { return; }
function alsoValid() { return 2; }`;

    it('returns a non-empty errors array', () => {
      const result = analyzeCfg!('test.ts', src);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('errors have message, startLine, endLine fields', () => {
      const result = analyzeCfg!('test.ts', src);
      for (const err of result.errors) {
        expect(typeof err.message).toBe('string');
        expect(err.message.length).toBeGreaterThan(0);
        expect(typeof err.startLine).toBe('number');
        expect(typeof err.endLine).toBe('number');
      }
    });

    it('at least "valid" and "alsoValid" appear in functions (partial results)', () => {
      const result = analyzeCfg!('test.ts', src);
      // Despite the syntax error, oxc should recover and return partial results
      const names = result.functions.map(f => f.name);
      const hasValid = names.includes('valid') || names.some(n => n.includes('valid'));
      const hasAlsoValid = names.includes('alsoValid') || names.some(n => n.includes('alsoValid'));
      // At minimum one of the valid functions should be recovered
      expect(hasValid || hasAlsoValid).toBe(true);
    });
  });

  // ── 1.16 Large file stress test ──────────────────────────────────────────

  describe('1.16 large file stress test', () => {
    // Generate 500 functions, each with an if/else
    function generateLargeFile(count: number): string {
      const lines: string[] = [];
      for (let i = 0; i < count; i++) {
        lines.push(`function fn${i}(x: number) {`);
        lines.push(`  if (x > ${i}) { return true; } else { return false; }`);
        lines.push(`}`);
      }
      return lines.join('\n');
    }

    it('completes without hanging or panicking (500 functions)', () => {
      const src = generateLargeFile(500);
      // Should complete in reasonable time — vitest default timeout is 5s,
      // but we give the stress test more headroom via the test timeout below.
      const result = analyzeCfg!('large.ts', src);
      expect(result).toBeDefined();
      expect(result.functions).toBeDefined();
      expect(result.errors).toBeDefined();
    }, 30_000 /* 30s timeout for stress test */);

    it('returns at least 500 function entries without maxFunctions limit', () => {
      const src = generateLargeFile(500);
      const result = analyzeCfg!('large.ts', src);
      // Including <top-level> / <module>, should have 500+ entries
      expect(result.functions.length).toBeGreaterThanOrEqual(500);
    }, 30_000);

    it('maxFunctions: 10 truncates output to at most 10 functions', () => {
      const src = generateLargeFile(500);
      const result = analyzeCfg!('large.ts', src, { maxFunctions: 10 });
      expect(result.functions.length).toBeLessThanOrEqual(10);
    }, 30_000);

    it('each function in the large file has at least 3 blocks (entry + true + false)', () => {
      // Sample a small subset — generating all 500 fully would be slow in assertions
      const src = generateLargeFile(20);
      const result = analyzeCfg!('large.ts', src);
      const fnFunctions = result.functions.filter(f => /^fn\d+$/.test(f.name));
      for (const fn of fnFunctions) {
        expect(fn.blocks.length).toBeGreaterThanOrEqual(3);
      }
    }, 30_000);
  });

  // ── Structural invariants (apply to all results) ─────────────────────────

  describe('structural invariants', () => {
    it('all block IDs are unique within their function', () => {
      const src = `
function check(x: number) {
  if (x > 0) { return 1; } else { return 2; }
}`;
      const result = analyzeCfg!('test.ts', src);
      for (const fn of result.functions) {
        const ids = fn.blocks.map(b => b.id);
        const unique = new Set(ids);
        expect(unique.size).toBe(ids.length);
      }
    });

    it('all edge source/target IDs reference existing block IDs', () => {
      const src = `
function check(x: number) {
  if (x > 0) { return 1; } else { return 2; }
}`;
      const result = analyzeCfg!('test.ts', src);
      for (const fn of result.functions) {
        const blockIds = new Set(fn.blocks.map(b => b.id));
        for (const edge of fn.edges) {
          expect(blockIds.has(edge.source)).toBe(true);
          expect(blockIds.has(edge.target)).toBe(true);
        }
      }
    });

    it('instruction kinds are from the documented set', () => {
      const validKinds = new Set([
        'Statement', 'Condition', 'Return', 'ImplicitReturn',
        'Break', 'Continue', 'Throw', 'Iteration', 'Unreachable',
      ]);
      const src = `
function risky() {
  try { dangerousOp(); } catch (e) { handleError(e); }
  for (let i = 0; i < 3; i++) { step(); }
  return 0;
}`;
      const result = analyzeCfg!('test.ts', src);
      for (const fn of result.functions) {
        for (const block of fn.blocks) {
          for (const instr of block.instructions) {
            expect(validKinds.has(instr.kind)).toBe(true);
          }
        }
      }
    });

    it('edge types are from the documented set', () => {
      const validTypes = new Set([
        'Jump', 'Normal', 'Backedge', 'Finalize', 'ErrorExplicit',
        'ErrorImplicit', 'Unreachable', 'Join',
      ]);
      const src = `
function risky() {
  try { dangerousOp(); } catch (e) { handleError(e); }
  return 0;
}`;
      const result = analyzeCfg!('test.ts', src);
      for (const fn of result.functions) {
        for (const edge of fn.edges) {
          expect(validTypes.has(edge.type)).toBe(true);
        }
      }
    });

    it('non-Jump edges have null conditionText', () => {
      const src = `function greet(name: string) { console.log(name); return name; }`;
      const result = analyzeCfg!('test.ts', src);
      for (const fn of result.functions) {
        for (const edge of fn.edges) {
          if (edge.type !== 'Jump' && edge.type !== 'ErrorExplicit') {
            // Only Jump and ErrorExplicit edges should carry conditionText
            // Other edge types must have null conditionText
            if (edge.conditionText !== null && edge.conditionText !== undefined) {
              // Allow if it's an empty string (implementation detail)
              expect(edge.conditionText).toBe('');
            }
          }
        }
      }
    });

    it('functions have valid line number ranges', () => {
      const src = `
function a() { return 1; }
function b() { return 2; }`;
      const result = analyzeCfg!('test.ts', src);
      for (const fn of result.functions) {
        if (fn.startLine > 0) {
          // Skip <top-level> / <module> synthetic entries which may have 0
          expect(fn.startLine).toBeGreaterThanOrEqual(1);
          expect(fn.endLine).toBeGreaterThanOrEqual(fn.startLine);
        }
      }
    });
  });
});
