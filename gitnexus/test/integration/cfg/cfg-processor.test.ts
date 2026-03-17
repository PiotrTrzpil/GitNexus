/**
 * Layer 3: CFG Processor Tests
 *
 * Tests processCfgFromExtracted() in isolation — no native binding required.
 * Input is hand-crafted ExtractedFileCfg data; assertions are on resulting
 * graph state (BasicBlock nodes, CFG_CONTAINS edges, CFG_EDGE relationships).
 *
 * Convention for hand-crafted test data:
 *   - Graph node startLine/endLine use tree-sitter 0-indexed rows.
 *   - ExtractedFunctionCfg startLine/endLine use oxc 1-indexed lines.
 *   - The processor converts oxc → tree-sitter (subtracts 1) before matching.
 *   - Blocks must have ≥1 instruction to avoid being filtered as error sinks.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { processCfgFromExtracted } from '../../../src/core/ingestion/cfg-processor.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createResolutionContext, type ResolutionContext } from '../../../src/core/ingestion/resolution-context.js';
import { generateId } from '../../../src/lib/utils.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';
import type { ExtractedFileCfg, ExtractedFunctionCfg } from '../../../src/core/ingestion/workers/parse-worker.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a minimal Function graph node (startLine/endLine are 0-indexed). */
function makeFunctionNode(
  filePath: string,
  name: string,
  startLine: number,
  endLine: number,
) {
  const id = generateId('Function', `${filePath}:${name}`);
  return {
    id,
    label: 'Function' as const,
    properties: {
      name,
      filePath,
      startLine,
      endLine,
      language: 'typescript' as any,
      isExported: false,
    },
  };
}

/** A minimal instruction so blocks aren't filtered as error sinks. */
const STMT = (line: number) => ({ kind: 'Statement', startLine: line, endLine: line, startColumn: null, endColumn: null, text: null });
const RET = (line: number, text: string | null = null) => ({ kind: 'Return', startLine: line, endLine: line, startColumn: null, endColumn: null, text });
const COND = (line: number, text: string) => ({ kind: 'Condition', startLine: line, endLine: line, startColumn: null, endColumn: null, text });

/** Build a minimal CfgBlock for hand-crafted test data. */
function makeCfgBlock(
  id: number,
  instructions: any[] = [],
  unreachable = false,
) {
  return { id, instructions, unreachable };
}

/** Build a minimal CfgEdge for hand-crafted test data. */
function makeCfgEdge(
  source: number,
  target: number,
  type: string,
  conditionText: string | null = null,
) {
  return { source, target, type, conditionText };
}

/** Build a minimal ExtractedFunctionCfg (startLine/endLine are oxc 1-indexed). */
function makeExtractedFunctionCfg(
  name: string,
  symbolId: string | null,
  startLine: number,
  endLine: number,
  blocks: any[],
  edges: any[],
  className: string | null = null,
): ExtractedFunctionCfg {
  return { name, symbolId, startLine, endLine, className, blocks, edges };
}

/** Build a minimal ExtractedFileCfg. */
function makeExtractedFileCfg(
  filePath: string,
  functions: ExtractedFunctionCfg[],
): ExtractedFileCfg {
  return { filePath, functions };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('processCfgFromExtracted', () => {
  let graph: KnowledgeGraph;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  /**
   * 3.1 Nodes and edges are created
   *
   * Create a KnowledgeGraph, add a Function node manually.
   * Call processCfgFromExtracted() with a hand-crafted ExtractedFileCfg (2 blocks, 1 edge).
   * Verify:
   *   - 2 BasicBlock nodes with correct blockIndex, instructionCount, isUnreachable
   *   - 1 CFG_EDGE relationship with correct cfgEdgeType
   *   - 2 CFG_CONTAINS relationships from Function → each BasicBlock
   */
  it('3.1: creates BasicBlock nodes, CFG_CONTAINS edges, and CFG_EDGE relationships', async () => {
    const FILE = 'src/service.ts';
    const funcNode = makeFunctionNode(FILE, 'processOrder', 5, 15);
    graph.addNode(funcNode);

    const blocks = [
      makeCfgBlock(0, [STMT(6)], false),
      makeCfgBlock(1, [RET(14, 'result')], false),
    ];
    const edges = [makeCfgEdge(0, 1, 'Normal')];

    const cfgData = makeExtractedFileCfg(FILE, [
      // oxc 1-indexed: startLine=6 (node is 0-indexed 5)
      makeExtractedFunctionCfg('processOrder', funcNode.id, 6, 16, blocks, edges),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    // ── BasicBlock nodes ──────────────────────────────────────────────────
    const basicBlocks = graph.nodes.filter(n => n.label === 'BasicBlock');
    expect(basicBlocks).toHaveLength(2);

    const block0 = basicBlocks.find(b => b.properties.blockIndex === 0);
    const block1 = basicBlocks.find(b => b.properties.blockIndex === 1);
    expect(block0).toBeDefined();
    expect(block1).toBeDefined();

    // blockIndex matches the CFG block id
    expect(block0!.properties.blockIndex).toBe(0);
    expect(block1!.properties.blockIndex).toBe(1);

    // instructionCount reflects number of instructions
    expect(block0!.properties.instructionCount).toBe(1);
    expect(block1!.properties.instructionCount).toBe(1);

    // isUnreachable reflects the block.unreachable flag
    expect(block0!.properties.isUnreachable).toBe(false);
    expect(block1!.properties.isUnreachable).toBe(false);

    // filePath is propagated
    expect(block0!.properties.filePath).toBe(FILE);
    expect(block1!.properties.filePath).toBe(FILE);

    // ── CFG_CONTAINS edges ────────────────────────────────────────────────
    const containsRels = graph.relationships.filter(r => r.type === 'CFG_CONTAINS');
    expect(containsRels).toHaveLength(2);

    // All CFG_CONTAINS edges originate from the Function node
    for (const rel of containsRels) {
      expect(rel.sourceId).toBe(funcNode.id);
      expect(rel.confidence).toBe(1.0);
    }

    // The targets are the two BasicBlock nodes
    const containsTargets = containsRels.map(r => r.targetId);
    expect(containsTargets).toContain(block0!.id);
    expect(containsTargets).toContain(block1!.id);

    // ── CFG_EDGE relationships ────────────────────────────────────────────
    const cfgEdges = graph.relationships.filter(r => r.type === 'CFG_EDGE');
    expect(cfgEdges).toHaveLength(1);

    const cfgEdge = cfgEdges[0];
    expect(cfgEdge.sourceId).toBe(block0!.id);
    expect(cfgEdge.targetId).toBe(block1!.id);
    expect(cfgEdge.cfgEdgeType).toBe('Normal');
    expect(cfgEdge.confidence).toBe(1.0);
  });

  /**
   * 3.2 Node ID determinism
   *
   * Run processCfgFromExtracted() twice with the same input.
   * Verify node IDs and relationship IDs are identical both times.
   */
  it('3.2: node and relationship IDs are deterministic across runs', async () => {
    const FILE = 'src/auth.ts';
    const funcNode = makeFunctionNode(FILE, 'validateToken', 0, 9);
    graph.addNode(funcNode);

    const blocks = [
      makeCfgBlock(0, [COND(2, 'token !== null')], false),
      makeCfgBlock(1, [RET(3, 'true')], false),
      makeCfgBlock(2, [RET(5, 'false')], false),
    ];
    const edges = [
      makeCfgEdge(0, 1, 'Jump', 'token !== null'),
      makeCfgEdge(0, 2, 'Normal'),
    ];

    const cfgData = makeExtractedFileCfg(FILE, [
      // oxc 1-indexed: 1–10
      makeExtractedFunctionCfg('validateToken', funcNode.id, 1, 10, blocks, edges),
    ]);

    // First run
    await processCfgFromExtracted(graph, [cfgData], ctx);

    const nodeIds1 = graph.nodes
      .filter(n => n.label === 'BasicBlock')
      .map(n => n.id)
      .sort();
    const relIds1 = graph.relationships
      .map(r => r.id)
      .sort();

    // Second run — reset graph and repeat
    const graph2 = createKnowledgeGraph();
    graph2.addNode(funcNode);

    await processCfgFromExtracted(graph2, [cfgData], ctx);

    const nodeIds2 = graph2.nodes
      .filter(n => n.label === 'BasicBlock')
      .map(n => n.id)
      .sort();
    const relIds2 = graph2.relationships
      .map(r => r.id)
      .sort();

    expect(nodeIds1).toEqual(nodeIds2);
    expect(relIds1).toEqual(relIds2);
  });

  /**
   * 3.3 Symbol ID fallback matching
   *
   * Create a Function node at 0-indexed lines 10-20.
   * Pass an ExtractedFunctionCfg with symbolId: null, oxc 1-indexed lines 11-21.
   * Verify the processor converts oxc→tree-sitter and matches by exact startLine.
   */
  it('3.3: falls back to line-range matching when symbolId is null', async () => {
    const FILE = 'src/payment.ts';
    // Graph node: tree-sitter 0-indexed
    const funcNode = makeFunctionNode(FILE, 'chargeCard', 10, 20);
    graph.addNode(funcNode);

    const blocks = [makeCfgBlock(0, [STMT(11)], false)];
    const edges: any[] = [];

    // symbolId: null — processor must use line-range fallback
    // oxc 1-indexed: startLine=11 → after -1 conversion = 10 (matches node)
    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('chargeCard', null, 11, 21, blocks, edges),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    // BasicBlock should have been created (processor found the Function node via line range)
    const basicBlocks = graph.nodes.filter(n => n.label === 'BasicBlock');
    expect(basicBlocks).toHaveLength(1);

    // CFG_CONTAINS should link from the Function node
    const containsRels = graph.relationships.filter(r => r.type === 'CFG_CONTAINS');
    expect(containsRels).toHaveLength(1);
    expect(containsRels[0].sourceId).toBe(funcNode.id);
  });

  /**
   * 3.3b Fallback containment matching
   *
   * When exact startLine doesn't match, containment matching (CFG range is
   * fully inside node range) should find the tightest enclosing function.
   */
  it('3.3b: fallback uses containment matching with tightest enclosing function', async () => {
    const FILE = 'src/nested.ts';
    // Outer function: lines 0-50 (0-indexed)
    const outerNode = makeFunctionNode(FILE, 'outer', 0, 50);
    // Inner function: lines 10-20 (0-indexed)
    const innerNode = makeFunctionNode(FILE, 'inner', 10, 20);
    graph.addNode(outerNode);
    graph.addNode(innerNode);

    const blocks = [makeCfgBlock(0, [STMT(12)], false)];

    // CFG fn with symbolId: null, oxc 1-indexed lines 12-18
    // After conversion: 0-indexed 11-17, which is inside inner(10-20) and outer(0-50).
    // Should match inner (tighter).
    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('mystery', null, 12, 18, blocks, []),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    const containsRels = graph.relationships.filter(r => r.type === 'CFG_CONTAINS');
    expect(containsRels).toHaveLength(1);
    expect(containsRels[0].sourceId).toBe(innerNode.id);
  });

  /**
   * 3.4 Orphaned CFG data (no matching Function node)
   *
   * Pass an ExtractedFunctionCfg with symbolId: null, lines that don't match any node.
   * Verify no BasicBlock nodes are created (skip gracefully, no crash).
   */
  it('3.4: skips gracefully when no matching Function node exists', async () => {
    const FILE = 'src/orphan.ts';
    // No Function node added to graph

    const blocks = [makeCfgBlock(0, [STMT(100)], false)];
    const edges: any[] = [];

    const cfgData = makeExtractedFileCfg(FILE, [
      // oxc 1-indexed lines 100-111 — no Function node exists at these lines
      makeExtractedFunctionCfg('phantomFn', null, 100, 111, blocks, edges),
    ]);

    // Should not throw
    await expect(processCfgFromExtracted(graph, [cfgData], ctx)).resolves.toBeUndefined();

    // No BasicBlock nodes should be created
    const basicBlocks = graph.nodes.filter(n => n.label === 'BasicBlock');
    expect(basicBlocks).toHaveLength(0);

    // No relationships should be created
    expect(graph.relationshipCount).toBe(0);
  });

  /**
   * 3.5 cfgInstructions JSON encoding
   *
   * Create a block with 3 instructions of different kinds.
   * Verify cfgInstructions property is valid JSON that round-trips to the
   * original instruction array.
   */
  it('3.5: cfgInstructions is valid JSON that round-trips to the instruction array', async () => {
    const FILE = 'src/router.ts';
    const funcNode = makeFunctionNode(FILE, 'handleRoute', 0, 19);
    graph.addNode(funcNode);

    const instructions = [
      { kind: 'Statement', startLine: 2, endLine: 2, startColumn: 2, endColumn: 20, text: null },
      { kind: 'Condition', startLine: 5, endLine: 5, startColumn: 6, endColumn: 25, text: 'req.method === "GET"' },
      { kind: 'Return', startLine: 10, endLine: 10, startColumn: 4, endColumn: 18, text: 'response' },
    ];
    const blocks = [makeCfgBlock(0, instructions, false)];
    const edges: any[] = [];

    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('handleRoute', funcNode.id, 1, 20, blocks, edges),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    const basicBlocks = graph.nodes.filter(n => n.label === 'BasicBlock');
    expect(basicBlocks).toHaveLength(1);

    const block = basicBlocks[0];

    // cfgInstructions must be a string (JSON-encoded)
    expect(typeof block.properties.cfgInstructions).toBe('string');

    // Must parse as valid JSON without throwing
    let parsed: any[];
    expect(() => {
      parsed = JSON.parse(block.properties.cfgInstructions!);
    }).not.toThrow();

    // Must round-trip to the original instruction array
    expect(parsed!).toHaveLength(3);
    expect(parsed![0].kind).toBe('Statement');
    expect(parsed![1].kind).toBe('Condition');
    expect(parsed![1].text).toBe('req.method === "GET"');
    expect(parsed![2].kind).toBe('Return');
    expect(parsed![2].text).toBe('response');

    // instructionCount should reflect the 3 instructions
    expect(block.properties.instructionCount).toBe(3);
  });

  // ── Additional robustness tests ──────────────────────────────────────────

  /**
   * Bonus: Jump edge conditionText is propagated to CFG_EDGE relationship.
   */
  it('conditionText is set on Jump CFG_EDGE relationships', async () => {
    const FILE = 'src/guard.ts';
    const funcNode = makeFunctionNode(FILE, 'checkAccess', 0, 14);
    graph.addNode(funcNode);

    const blocks = [
      makeCfgBlock(0, [COND(2, 'user.isAdmin')], false),
      makeCfgBlock(1, [RET(3, 'true')], false),
      makeCfgBlock(2, [RET(5, 'false')], false),
    ];
    const edges = [
      makeCfgEdge(0, 1, 'Jump', 'user.isAdmin'),
      makeCfgEdge(0, 2, 'Normal', null),
    ];

    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('checkAccess', funcNode.id, 1, 15, blocks, edges),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    const cfgEdges = graph.relationships.filter(r => r.type === 'CFG_EDGE');
    expect(cfgEdges).toHaveLength(2);

    const jumpEdge = cfgEdges.find(r => r.cfgEdgeType === 'Jump');
    expect(jumpEdge).toBeDefined();
    expect(jumpEdge!.conditionText).toBe('user.isAdmin');

    const normalEdge = cfgEdges.find(r => r.cfgEdgeType === 'Normal');
    expect(normalEdge).toBeDefined();
    expect(normalEdge!.conditionText).toBeUndefined();
  });

  /**
   * Bonus: Unreachable blocks get isUnreachable: true on their BasicBlock node.
   */
  it('unreachable blocks have isUnreachable: true on their BasicBlock node', async () => {
    const FILE = 'src/dead.ts';
    const funcNode = makeFunctionNode(FILE, 'deadCode', 0, 9);
    graph.addNode(funcNode);

    const blocks = [
      makeCfgBlock(0, [RET(2, '42')], false),
      makeCfgBlock(1, [STMT(4)], true),
    ];
    const edges: any[] = [];

    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('deadCode', funcNode.id, 1, 10, blocks, edges),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    const basicBlocks = graph.nodes.filter(n => n.label === 'BasicBlock');
    expect(basicBlocks).toHaveLength(2);

    const reachableBlock = basicBlocks.find(b => b.properties.blockIndex === 0);
    const unreachableBlock = basicBlocks.find(b => b.properties.blockIndex === 1);

    expect(reachableBlock!.properties.isUnreachable).toBe(false);
    expect(unreachableBlock!.properties.isUnreachable).toBe(true);
  });

  /**
   * Bonus: CFG data for multiple functions in the same file are all processed.
   */
  it('processes multiple functions in the same file', async () => {
    const FILE = 'src/multi.ts';
    const func1 = makeFunctionNode(FILE, 'funcA', 0, 4);
    const func2 = makeFunctionNode(FILE, 'funcB', 9, 19);
    graph.addNode(func1);
    graph.addNode(func2);

    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('funcA', func1.id, 1, 5, [
        makeCfgBlock(0, [RET(2, '1')], false),
      ], []),
      makeExtractedFunctionCfg('funcB', func2.id, 10, 20, [
        makeCfgBlock(0, [STMT(11)], false),
        makeCfgBlock(1, [RET(15)], false),
      ], [makeCfgEdge(0, 1, 'Normal')]),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    // funcA: 1 block; funcB: 2 blocks → 3 total BasicBlock nodes
    const basicBlocks = graph.nodes.filter(n => n.label === 'BasicBlock');
    expect(basicBlocks).toHaveLength(3);

    // CFG_CONTAINS: 1 for funcA + 2 for funcB = 3
    const containsRels = graph.relationships.filter(r => r.type === 'CFG_CONTAINS');
    expect(containsRels).toHaveLength(3);

    // CFG_EDGE: 1 for funcB
    const cfgEdges = graph.relationships.filter(r => r.type === 'CFG_EDGE');
    expect(cfgEdges).toHaveLength(1);
  });

  // ── Outcome-based integration tests ────────────────────────────────────────

  /**
   * ErrorImplicit edges are filtered out of the graph.
   * These are synthetic "any statement could throw" edges that add noise.
   */
  it('filters out ErrorImplicit edges', async () => {
    const FILE = 'src/try.ts';
    const funcNode = makeFunctionNode(FILE, 'risky', 0, 9);
    graph.addNode(funcNode);

    const blocks = [
      makeCfgBlock(0, [STMT(1)], false),
      makeCfgBlock(1, [STMT(3)], false),
      makeCfgBlock(2, [RET(5)], false),
    ];
    const edges = [
      makeCfgEdge(0, 1, 'Normal'),
      makeCfgEdge(0, 2, 'ErrorImplicit'),  // should be filtered
      makeCfgEdge(1, 2, 'Normal'),
      makeCfgEdge(1, 2, 'ErrorImplicit'),  // should be filtered
    ];

    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('risky', funcNode.id, 1, 10, blocks, edges),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    // Only 2 Normal edges should survive — both ErrorImplicit edges are filtered
    const cfgEdges = graph.relationships.filter(r => r.type === 'CFG_EDGE');
    expect(cfgEdges).toHaveLength(2);
    for (const edge of cfgEdges) {
      expect(edge.cfgEdgeType).toBe('Normal');
    }
  });

  /**
   * Error sink blocks (0 instructions, only ErrorImplicit incoming edges)
   * are removed from the graph to avoid orphaned nodes after edge filtering.
   */
  it('removes error sink blocks (0 instructions, only ErrorImplicit incoming)', async () => {
    const FILE = 'src/sink.ts';
    const funcNode = makeFunctionNode(FILE, 'withSink', 0, 9);
    graph.addNode(funcNode);

    const blocks = [
      makeCfgBlock(0, [STMT(1)], false),
      makeCfgBlock(1, [RET(3)], false),
      // Error sink: 0 instructions, only receives ErrorImplicit edges
      makeCfgBlock(2, [], false),
    ];
    const edges = [
      makeCfgEdge(0, 1, 'Normal'),
      makeCfgEdge(0, 2, 'ErrorImplicit'),
      makeCfgEdge(1, 2, 'ErrorImplicit'),
    ];

    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('withSink', funcNode.id, 1, 10, blocks, edges),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    // Only blocks 0 and 1 should survive — block 2 (error sink) is removed
    const basicBlocks = graph.nodes.filter(n => n.label === 'BasicBlock');
    expect(basicBlocks).toHaveLength(2);
    expect(basicBlocks.map(b => b.properties.blockIndex).sort()).toEqual([0, 1]);

    // Only the Normal edge (0→1) survives
    const cfgEdges = graph.relationships.filter(r => r.type === 'CFG_EDGE');
    expect(cfgEdges).toHaveLength(1);
    expect(cfgEdges[0].cfgEdgeType).toBe('Normal');
  });

  /**
   * Non-error-sink empty blocks are preserved.
   * A block with 0 instructions but a non-ErrorImplicit incoming edge should NOT
   * be filtered (it could be a join point or empty branch target).
   */
  it('preserves empty blocks that have non-ErrorImplicit incoming edges', async () => {
    const FILE = 'src/join.ts';
    const funcNode = makeFunctionNode(FILE, 'withJoin', 0, 9);
    graph.addNode(funcNode);

    const blocks = [
      makeCfgBlock(0, [COND(1, 'x > 0')], false),
      makeCfgBlock(1, [STMT(2)], false),
      // Empty join block — has a Normal incoming edge, NOT an error sink
      makeCfgBlock(2, [], false),
    ];
    const edges = [
      makeCfgEdge(0, 1, 'Jump', 'x > 0'),
      makeCfgEdge(0, 2, 'Normal'),  // Normal edge → block 2 should survive
      makeCfgEdge(1, 2, 'Normal'),
    ];

    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('withJoin', funcNode.id, 1, 10, blocks, edges),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    // All 3 blocks should survive — block 2 has Normal incoming edges
    const basicBlocks = graph.nodes.filter(n => n.label === 'BasicBlock');
    expect(basicBlocks).toHaveLength(3);
  });

  /**
   * Dangling edges (referencing unknown block IDs) are silently skipped.
   */
  it('skips edges with unknown block ID references', async () => {
    const FILE = 'src/dangling.ts';
    const funcNode = makeFunctionNode(FILE, 'withDangling', 0, 9);
    graph.addNode(funcNode);

    const blocks = [
      makeCfgBlock(0, [STMT(1)], false),
      makeCfgBlock(1, [RET(3)], false),
    ];
    const edges = [
      makeCfgEdge(0, 1, 'Normal'),
      makeCfgEdge(0, 99, 'Normal'),   // target 99 doesn't exist
      makeCfgEdge(77, 1, 'Normal'),   // source 77 doesn't exist
    ];

    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('withDangling', funcNode.id, 1, 10, blocks, edges),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    // Only the valid edge 0→1 should be created
    const cfgEdges = graph.relationships.filter(r => r.type === 'CFG_EDGE');
    expect(cfgEdges).toHaveLength(1);
    expect(cfgEdges[0].cfgEdgeType).toBe('Normal');
  });

  /**
   * BasicBlock startLine/endLine are derived from instruction line ranges.
   * The block's line range should be the min startLine and max endLine
   * across all its instructions.
   */
  it('derives block startLine/endLine from instruction line ranges', async () => {
    const FILE = 'src/range.ts';
    const funcNode = makeFunctionNode(FILE, 'multiLine', 0, 19);
    graph.addNode(funcNode);

    const blocks = [
      makeCfgBlock(0, [
        { kind: 'Statement', startLine: 5, endLine: 5, startColumn: null, endColumn: null, text: null },
        { kind: 'Statement', startLine: 3, endLine: 3, startColumn: null, endColumn: null, text: null },
        { kind: 'Return', startLine: 8, endLine: 10, startColumn: null, endColumn: null, text: null },
      ], false),
    ];

    const cfgData = makeExtractedFileCfg(FILE, [
      makeExtractedFunctionCfg('multiLine', funcNode.id, 1, 20, blocks, []),
    ]);

    await processCfgFromExtracted(graph, [cfgData], ctx);

    const basicBlocks = graph.nodes.filter(n => n.label === 'BasicBlock');
    expect(basicBlocks).toHaveLength(1);

    const block = basicBlocks[0];
    expect(block.properties.startLine).toBe(3); // min across instructions
    expect(block.properties.endLine).toBe(10);  // max across instructions
  });

  /**
   * Multiple files in a single cfgData batch are all processed correctly.
   */
  it('processes CFG data from multiple files', async () => {
    const FILE_A = 'src/a.ts';
    const FILE_B = 'src/b.ts';
    const funcA = makeFunctionNode(FILE_A, 'fnA', 0, 4);
    const funcB = makeFunctionNode(FILE_B, 'fnB', 0, 4);
    graph.addNode(funcA);
    graph.addNode(funcB);

    const cfgDataA = makeExtractedFileCfg(FILE_A, [
      makeExtractedFunctionCfg('fnA', funcA.id, 1, 5, [makeCfgBlock(0, [RET(2)], false)], []),
    ]);
    const cfgDataB = makeExtractedFileCfg(FILE_B, [
      makeExtractedFunctionCfg('fnB', funcB.id, 1, 5, [makeCfgBlock(0, [RET(2)], false)], []),
    ]);

    await processCfgFromExtracted(graph, [cfgDataA, cfgDataB], ctx);

    const basicBlocks = graph.nodes.filter(n => n.label === 'BasicBlock');
    expect(basicBlocks).toHaveLength(2);

    const containsRels = graph.relationships.filter(r => r.type === 'CFG_CONTAINS');
    expect(containsRels).toHaveLength(2);

    // One block belongs to funcA, the other to funcB
    const parentIds = new Set(containsRels.map(r => r.sourceId));
    expect(parentIds.has(funcA.id)).toBe(true);
    expect(parentIds.has(funcB.id)).toBe(true);
  });
});
