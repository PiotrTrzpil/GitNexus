import { KnowledgeGraph, GraphNode } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import type { ResolutionContext } from './resolution-context.js';
import { yieldToEventLoop } from './utils.js';
import type { ExtractedFileCfg, ExtractedFunctionCfg } from './workers/parse-worker.js';

/**
 * Find the parent Function/Method graph node for a given CFG function entry.
 *
 * Resolution order:
 *  1. Direct lookup by symbolId (O(1)) — set by the parse worker when it
 *     could match the CFG function to a tree-sitter symbol by name+line.
 *  2. Line-range fallback — iterate nodes in the same file and find a
 *     Function/Method whose (startLine, endLine) encompasses the CFG
 *     function's range. Prefer exact startLine match over containment.
 *
 * Returns the matched GraphNode, or undefined if no match is found.
 */
function findParentNode(
  graph: KnowledgeGraph,
  filePath: string,
  cfgFn: ExtractedFunctionCfg,
): GraphNode | undefined {
  // Fast path: symbolId set by parse worker.
  if (cfgFn.symbolId !== null) {
    return graph.getNode(cfgFn.symbolId);
  }

  // Fallback: line-range matching.
  // Collect candidates: Function/Method nodes in the same file whose line
  // range encompasses the CFG function's range.
  let exactMatch: GraphNode | undefined;
  let containsMatch: GraphNode | undefined;

  graph.forEachNode((node) => {
    if (node.label !== 'Function' && node.label !== 'Method' && node.label !== 'Constructor') return;
    if (node.properties.filePath !== filePath) return;

    const nodeStart = node.properties.startLine;
    const nodeEnd = node.properties.endLine;
    if (nodeStart === undefined || nodeEnd === undefined) return;

    // Exact startLine match — strongest signal.
    if (nodeStart === cfgFn.startLine) {
      exactMatch = node;
      return;
    }

    // Containment: CFG function range is fully inside node range.
    if (nodeStart <= cfgFn.startLine && nodeEnd >= cfgFn.endLine) {
      // Prefer the tightest enclosing range if multiple match.
      if (
        containsMatch === undefined ||
        (nodeEnd - nodeStart) <
          ((containsMatch.properties.endLine ?? 0) -
            (containsMatch.properties.startLine ?? 0))
      ) {
        containsMatch = node;
      }
    }
  });

  return exactMatch ?? containsMatch;
}

/**
 * Map extracted CFG data into graph nodes (BasicBlock) and edges
 * (CFG_CONTAINS, CFG_EDGE).
 *
 * For each ExtractedFileCfg → ExtractedFunctionCfg:
 *  - Locate the parent Function/Method node (by symbolId or line-range).
 *  - Create one BasicBlock node per block.
 *  - Create one CFG_CONTAINS edge from parent → each BasicBlock.
 *  - Create one CFG_EDGE relationship per control flow edge between blocks.
 *
 * Functions with no matching parent node are silently skipped — the CFG data
 * may arrive for anonymous or generated functions that have no symbol entry.
 *
 * @param graph        The knowledge graph to mutate.
 * @param cfgData      Per-file CFG data from the parse worker.
 * @param ctx          Resolution context (reserved for future use; not consumed today).
 * @param onProgress   Optional progress callback invoked per file processed.
 */
export const processCfgFromExtracted = async (
  graph: KnowledgeGraph,
  cfgData: ExtractedFileCfg[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
): Promise<void> => {
  const total = cfgData.length;

  for (let fileIdx = 0; fileIdx < cfgData.length; fileIdx++) {
    const fileCfg = cfgData[fileIdx];

    // Yield periodically to avoid blocking the event loop.
    if (fileIdx % 50 === 0) {
      onProgress?.(fileIdx, total);
      await yieldToEventLoop();
    }

    for (const cfgFn of fileCfg.functions) {
      const parentNode = findParentNode(graph, fileCfg.filePath, cfgFn);

      // No matching parent — skip this function gracefully.
      if (parentNode === undefined) {
        continue;
      }

      const parentNodeId = parentNode.id;

      // Map block.id → BasicBlock node id, so we can wire CFG_EDGE relationships
      // after all blocks are created.
      const blockNodeIds = new Map<number, string>();

      // Identify error handler sink blocks: blocks with zero instructions
      // that only receive ErrorImplicit edges. These are synthetic OXC nodes
      // that become orphans after ErrorImplicit filtering.
      const errorSinkBlockIds = new Set<number>();
      for (const block of cfgFn.blocks) {
        if (block.instructions.length > 0) continue;
        // Check if this block only has incoming ErrorImplicit edges
        const hasNonErrorIncoming = cfgFn.edges.some(
          e => e.target === block.id && e.type !== 'ErrorImplicit',
        );
        if (!hasNonErrorIncoming) {
          errorSinkBlockIds.add(block.id);
        }
      }

      // ── Create BasicBlock nodes ──────────────────────────────────────────
      for (const block of cfgFn.blocks) {
        if (errorSinkBlockIds.has(block.id)) continue;
        const basicBlockNodeId = generateId('BasicBlock', `${parentNodeId}:${block.id}`);
        blockNodeIds.set(block.id, basicBlockNodeId);

        // Derive startLine/endLine from the first/last instruction with location data.
        let startLine: number | undefined;
        let endLine: number | undefined;
        for (const instr of block.instructions) {
          if (instr.startLine !== null) {
            if (startLine === undefined || instr.startLine < startLine) {
              startLine = instr.startLine;
            }
          }
          if (instr.endLine !== null) {
            if (endLine === undefined || instr.endLine > endLine) {
              endLine = instr.endLine;
            }
          }
        }

        graph.addNode({
          id: basicBlockNodeId,
          label: 'BasicBlock',
          properties: {
            name: `block_${block.id}`,
            filePath: fileCfg.filePath,
            startLine,
            endLine,
            blockIndex: block.id,
            instructionCount: block.instructions.length,
            isUnreachable: block.unreachable,
            cfgInstructions: JSON.stringify(block.instructions),
          },
        });

        // CFG_CONTAINS: parent Function/Method → BasicBlock
        const containsRelId = generateId('CFG_CONTAINS', `${parentNodeId}->${basicBlockNodeId}`);
        graph.addRelationship({
          id: containsRelId,
          sourceId: parentNodeId,
          targetId: basicBlockNodeId,
          type: 'CFG_CONTAINS',
          confidence: 1.0,
          reason: '',
        });
      }

      // ── Create CFG_EDGE relationships ────────────────────────────────────
      // Skip ErrorImplicit edges: OXC generates one from every block to a
      // synthetic error handler sink (an empty block with no source location).
      // These represent "any statement could throw" — they're correct but add
      // ~45% edge noise that inflates complexity metrics without aiding analysis.
      for (const edge of cfgFn.edges) {
        if (edge.type === 'ErrorImplicit') continue;

        const sourceBlockNodeId = blockNodeIds.get(edge.source);
        const targetBlockNodeId = blockNodeIds.get(edge.target);

        // Both endpoints must have been created — edges referencing unknown
        // block IDs indicate a data contract violation; skip defensively.
        if (sourceBlockNodeId === undefined || targetBlockNodeId === undefined) {
          continue;
        }

        const cfgEdgeRelId = generateId(
          'CFG_EDGE',
          `${sourceBlockNodeId}->${targetBlockNodeId}:${edge.type}`,
        );

        graph.addRelationship({
          id: cfgEdgeRelId,
          sourceId: sourceBlockNodeId,
          targetId: targetBlockNodeId,
          type: 'CFG_EDGE',
          confidence: 1.0,
          reason: '',
          cfgEdgeType: edge.type,
          ...(edge.conditionText !== null ? { conditionText: edge.conditionText } : {}),
        });
      }
    }
  }

  onProgress?.(total, total);
};
