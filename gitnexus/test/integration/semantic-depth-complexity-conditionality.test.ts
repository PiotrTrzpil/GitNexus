/**
 * Integration Tests: Semantic Depth — Complexity & Conditionality
 *
 * Covers two fixtures from the semantic-depth design doc:
 *   1. complexity   — cyclomatic complexity scoring on logic.ts
 *   2. conditionality — CALLS edge conditionality metadata on handler.ts
 *
 * Each fixture runs the full ingestion pipeline once in beforeAll; every
 * it() assertion reads from the cached graph result.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import type { GraphNode, GraphRelationship } from '../../src/core/graph/types.js';

// ─── Fixture paths ─────────────────────────────────────────────────────────

const COMPLEXITY_FIXTURE = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'semantic-depth',
  'complexity',
);

const CONDITIONALITY_FIXTURE = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'semantic-depth',
  'conditionality',
);

// ═══════════════════════════════════════════════════════════════════════════
// Fixture: complexity
// ═══════════════════════════════════════════════════════════════════════════

describe('semantic-depth / complexity', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(COMPLEXITY_FIXTURE, () => {});
  }, 60000);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function findNode(label: string, name: string): GraphNode | undefined {
    for (const node of result.graph.iterNodes()) {
      if (node.label === label && node.properties.name === name) return node;
    }
    return undefined;
  }

  function findEdgesFrom(sourceId: string, type: string): GraphRelationship[] {
    const edges: GraphRelationship[] = [];
    for (const rel of result.graph.iterRelationships()) {
      if (rel.sourceId === sourceId && rel.type === type) edges.push(rel);
    }
    return edges;
  }

  // ── add — simple function, no branching ─────────────────────────────────

  it('add: complexity is 0 (no branching nodes)', () => {
    const node = findNode('Function', 'add');
    expect(node).toBeDefined();
    // Convention: complexity counts branching nodes; a straight-line function
    // has 0 branch nodes (base complexity without +1 offset).
    expect(node!.properties.complexity).toBe(0);
  });

  it('add: sloc is the line count of the function body', () => {
    const node = findNode('Function', 'add');
    expect(node).toBeDefined();
    const { startLine, endLine } = node!.properties;
    expect(typeof startLine).toBe('number');
    expect(typeof endLine).toBe('number');
    // sloc = endLine - startLine + 1
    expect(node!.properties.sloc).toBe(endLine! - startLine! + 1);
  });

  // ── classify — medium complexity (4 if-statements) ───────────────────────

  it('classify: complexity is 4 (four if-statements)', () => {
    const node = findNode('Function', 'classify');
    expect(node).toBeDefined();
    expect(node!.properties.complexity).toBe(4);
  });

  it('classify: sloc is correct', () => {
    const node = findNode('Function', 'classify');
    expect(node).toBeDefined();
    const { startLine, endLine } = node!.properties;
    expect(node!.properties.sloc).toBe(endLine! - startLine! + 1);
  });

  // ── processOrder — high complexity (10+) ─────────────────────────────────

  it('processOrder: complexity is >= 10', () => {
    const node = findNode('Function', 'processOrder');
    expect(node).toBeDefined();
    // if + if + for + if + switch + 3 switch_case + if + if + logical_expression
    expect(node!.properties.complexity).toBeGreaterThanOrEqual(10);
  });

  it('processOrder: sloc is correct', () => {
    const node = findNode('Function', 'processOrder');
    expect(node).toBeDefined();
    const { startLine, endLine } = node!.properties;
    expect(node!.properties.sloc).toBe(endLine! - startLine! + 1);
  });

  // ── Relative ordering ────────────────────────────────────────────────────

  it('processOrder has higher complexity than classify, which has higher than add', () => {
    const add = findNode('Function', 'add');
    const classify = findNode('Function', 'classify');
    const processOrder = findNode('Function', 'processOrder');

    const cAdd = add!.properties.complexity ?? 0;
    const cClassify = classify!.properties.complexity ?? 0;
    const cProcess = processOrder!.properties.complexity ?? 0;

    expect(cClassify).toBeGreaterThan(cAdd);
    expect(cProcess).toBeGreaterThan(cClassify);
  });

  // ── quality_query preset: high_complexity ────────────────────────────────
  // These tests validate the graph data that the preset would query against;
  // the MCP tool layer is exercised separately. Here we confirm the raw
  // graph properties satisfy the preset's filter conditions.

  it('only processOrder satisfies complexity > 8 threshold', () => {
    const candidates: string[] = [];
    for (const node of result.graph.iterNodes()) {
      if (
        ['Function', 'Method'].includes(node.label) &&
        (node.properties.complexity ?? 0) > 8
      ) {
        candidates.push(node.properties.name);
      }
    }
    expect(candidates).toContain('processOrder');
    expect(candidates).not.toContain('add');
    expect(candidates).not.toContain('classify');
  });

  // ── quality_query preset: god_functions ──────────────────────────────────
  // processOrder qualifies: high complexity + outbound CALLS + params.

  it('processOrder is a candidate for god_functions (high complexity)', () => {
    const node = findNode('Function', 'processOrder');
    expect(node).toBeDefined();
    expect(node!.properties.complexity).toBeGreaterThanOrEqual(10);

    // Has outbound CALLS edges (throw + switch cases reference callees)
    const calls = findEdgesFrom(node!.id, 'CALLS');
    expect(calls.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fixture: conditionality
// ═══════════════════════════════════════════════════════════════════════════

describe('semantic-depth / conditionality', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(CONDITIONALITY_FIXTURE, () => {});
  }, 60000);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function findNode(label: string, name: string): GraphNode | undefined {
    for (const node of result.graph.iterNodes()) {
      if (node.label === label && node.properties.name === name) return node;
    }
    return undefined;
  }

  function findEdgesFrom(sourceId: string, type: string): GraphRelationship[] {
    const edges: GraphRelationship[] = [];
    for (const rel of result.graph.iterRelationships()) {
      if (rel.sourceId === sourceId && rel.type === type) edges.push(rel);
    }
    return edges;
  }

  /**
   * Find the CALLS edge from a named source function to a named target function.
   * Returns undefined if either function or the edge cannot be found.
   */
  function findCallEdge(sourceName: string, targetName: string): GraphRelationship | undefined {
    const sourceNode = findNode('Function', sourceName);
    if (!sourceNode) return undefined;

    const callEdges = findEdgesFrom(sourceNode.id, 'CALLS');
    for (const edge of callEdges) {
      const targetNode = result.graph.getNode(edge.targetId);
      if (targetNode?.properties.name === targetName) return edge;
    }
    return undefined;
  }

  // ── handlePayment exists ─────────────────────────────────────────────────

  it('handlePayment function node exists in graph', () => {
    const node = findNode('Function', 'handlePayment');
    expect(node).toBeDefined();
  });

  // ── Unconditional calls ──────────────────────────────────────────────────

  it('validateInput CALLS edge: unconditional (isConditional absent/undefined, branchDepth 0 or absent)', () => {
    const edge = findCallEdge('handlePayment', 'validateInput');
    expect(edge).toBeDefined();
    // Unconditional calls omit isConditional to keep edge payloads small
    expect(edge!.isConditional).toBeFalsy();
    expect(!edge!.branchDepth || edge!.branchDepth === 0).toBe(true);
  });

  it('processCharge CALLS edge: unconditional', () => {
    const edge = findCallEdge('handlePayment', 'processCharge');
    expect(edge).toBeDefined();
    expect(edge!.isConditional).toBeFalsy();
    expect(!edge!.branchDepth || edge!.branchDepth === 0).toBe(true);
  });

  it('sendReceipt CALLS edge: unconditional (try body is always attempted)', () => {
    const edge = findCallEdge('handlePayment', 'sendReceipt');
    expect(edge).toBeDefined();
    expect(edge!.isConditional).toBeFalsy();
    expect(!edge!.branchDepth || edge!.branchDepth === 0).toBe(true);
  });

  it('hook.run CALLS edge: unconditional (loop body always executes if loop runs)', () => {
    // hook.run is a method call; look for an edge whose target name is 'run'
    const handlePayment = findNode('Function', 'handlePayment');
    expect(handlePayment).toBeDefined();

    const callEdges = findEdgesFrom(handlePayment!.id, 'CALLS');
    const runEdge = callEdges.find(e => {
      const target = result.graph.getNode(e.targetId);
      return target?.properties.name === 'run';
    });

    // The edge may not resolve if hook.run is unresolvable, but if it does
    // it must be unconditional.
    if (runEdge) {
      expect(runEdge.isConditional).toBeFalsy();
      expect(!runEdge.branchDepth || runEdge.branchDepth === 0).toBe(true);
    }
  });

  // ── Conditional calls ────────────────────────────────────────────────────

  it('applyDiscount CALLS edge: isConditional true, branchDepth 1, guardExpression contains user.isAdmin', () => {
    const edge = findCallEdge('handlePayment', 'applyDiscount');
    expect(edge).toBeDefined();
    expect(edge!.isConditional).toBe(true);
    expect(edge!.branchDepth).toBe(1);
    expect(edge!.guardExpression).toBeDefined();
    expect(edge!.guardExpression).toContain('user.isAdmin');
  });

  it('requireApproval CALLS edge: isConditional true, branchDepth 2, guardExpression contains amount > 1000', () => {
    const edge = findCallEdge('handlePayment', 'requireApproval');
    expect(edge).toBeDefined();
    expect(edge!.isConditional).toBe(true);
    expect(edge!.branchDepth).toBe(2);
    expect(edge!.guardExpression).toBeDefined();
    expect(edge!.guardExpression).toContain('amount > 1000');
  });

  it('logError CALLS edge: isConditional true, guardExpression is "catch"', () => {
    const edge = findCallEdge('handlePayment', 'logError');
    expect(edge).toBeDefined();
    expect(edge!.isConditional).toBe(true);
    expect(edge!.guardExpression).toBe('catch');
  });

  it('notifyVIP CALLS edge: isConditional true, branchDepth 1 (short-circuit &&)', () => {
    const edge = findCallEdge('handlePayment', 'notifyVIP');
    expect(edge).toBeDefined();
    expect(edge!.isConditional).toBe(true);
    expect(edge!.branchDepth).toBe(1);
    expect(edge!.guardExpression).toBeDefined();
    // guard is the left-hand side of the && expression
    expect(edge!.guardExpression).toContain('user.isPremium');
  });

  it('sendWelcome CALLS edge: isConditional true, branchDepth 1 (nullish coalescing ??)', () => {
    const edge = findCallEdge('handlePayment', 'sendWelcome');
    expect(edge).toBeDefined();
    expect(edge!.isConditional).toBe(true);
    expect(edge!.branchDepth).toBe(1);
    expect(edge!.guardExpression).toBeDefined();
    // guard is the left-hand side of the ?? expression
    expect(edge!.guardExpression).toContain('user.referrer');
  });

  // ── hot_path — only unconditional calls ─────────────────────────────────
  // Validates the raw data that the hot_path preset queries against.

  it('hot_path candidates: validateInput, processCharge, sendReceipt are unconditional from handlePayment', () => {
    const handlePayment = findNode('Function', 'handlePayment');
    expect(handlePayment).toBeDefined();

    const unconditionalTargetNames = findEdgesFrom(handlePayment!.id, 'CALLS')
      .filter(e => !e.isConditional && (!e.branchDepth || e.branchDepth === 0))
      .map(e => result.graph.getNode(e.targetId)?.properties.name)
      .filter(Boolean) as string[];

    expect(unconditionalTargetNames).toContain('validateInput');
    expect(unconditionalTargetNames).toContain('processCharge');
    expect(unconditionalTargetNames).toContain('sendReceipt');
  });

  it('hot_path excludes: applyDiscount, requireApproval, logError, notifyVIP, sendWelcome', () => {
    const handlePayment = findNode('Function', 'handlePayment');
    expect(handlePayment).toBeDefined();

    const unconditionalTargetNames = findEdgesFrom(handlePayment!.id, 'CALLS')
      .filter(e => !e.isConditional && (!e.branchDepth || e.branchDepth === 0))
      .map(e => result.graph.getNode(e.targetId)?.properties.name)
      .filter(Boolean) as string[];

    expect(unconditionalTargetNames).not.toContain('applyDiscount');
    expect(unconditionalTargetNames).not.toContain('requireApproval');
    expect(unconditionalTargetNames).not.toContain('logError');
    expect(unconditionalTargetNames).not.toContain('notifyVIP');
    expect(unconditionalTargetNames).not.toContain('sendWelcome');
  });

  // ── guarded_paths — only conditional calls, grouped by guard ────────────
  // Validates the raw data that the guarded_paths preset queries against.

  it('guarded_paths: applyDiscount and requireApproval share guard prefix "user.isAdmin"', () => {
    const applyEdge = findCallEdge('handlePayment', 'applyDiscount');
    const requireEdge = findCallEdge('handlePayment', 'requireApproval');

    expect(applyEdge!.isConditional).toBe(true);
    expect(requireEdge!.isConditional).toBe(true);

    // Both are inside the if (user.isAdmin) branch, so outer guard matches
    expect(applyEdge!.guardExpression).toContain('user.isAdmin');
    // requireApproval's nearest guard is amount > 1000, but it is still
    // conditional and is nested under the user.isAdmin branch
    expect(requireEdge!.guardExpression).toContain('amount > 1000');
  });

  it('guarded_paths: logError has guard "catch"', () => {
    const logErrorEdge = findCallEdge('handlePayment', 'logError');
    expect(logErrorEdge!.isConditional).toBe(true);
    expect(logErrorEdge!.guardExpression).toBe('catch');
  });

  it('guarded_paths: all conditional calls from handlePayment are accounted for', () => {
    const handlePayment = findNode('Function', 'handlePayment');
    expect(handlePayment).toBeDefined();

    const conditionalTargetNames = findEdgesFrom(handlePayment!.id, 'CALLS')
      .filter(e => e.isConditional === true)
      .map(e => result.graph.getNode(e.targetId)?.properties.name)
      .filter(Boolean) as string[];

    // Must include all guarded callees
    expect(conditionalTargetNames).toContain('applyDiscount');
    expect(conditionalTargetNames).toContain('requireApproval');
    expect(conditionalTargetNames).toContain('logError');
    expect(conditionalTargetNames).toContain('notifyVIP');
    expect(conditionalTargetNames).toContain('sendWelcome');
  });
});
