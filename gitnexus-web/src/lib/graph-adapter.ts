import Graph, { MultiGraph } from 'graphology';
import { KnowledgeGraph, NodeLabel } from '../core/graph/types';
import { NODE_COLORS, NODE_SIZES, getCommunityColor } from './constants';

export interface SigmaNodeAttributes {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  nodeType: NodeLabel;
  filePath: string;
  startLine?: number;
  endLine?: number;
  hidden?: boolean;
  zIndex?: number;
  highlighted?: boolean;
  mass?: number; // ForceAtlas2 mass - higher = more repulsion
  community?: number; // Community index from Leiden algorithm
  communityColor?: string; // Color assigned by community
}

export interface SigmaEdgeAttributes {
  size: number;
  color: string;
  relationType: string;
  type?: string;
  curvature?: number;
  zIndex?: number;
}

/**
 * Get node size scaled for graph density
 * Uses lower minimums to maintain hierarchy visibility even in huge graphs
 */
const getScaledNodeSize = (baseSize: number, nodeCount: number): number => {
  // Scale factor decreases as graph gets larger
  // But a minimum is used that preserves relative differences
  if (nodeCount > 50000) return Math.max(1, baseSize * 0.4);
  if (nodeCount > 20000) return Math.max(1.5, baseSize * 0.5);
  if (nodeCount > 5000) return Math.max(2, baseSize * 0.65);
  if (nodeCount > 1000) return Math.max(2.5, baseSize * 0.8);
  return baseSize;
};

/**
 * Get mass for node type - higher mass = more repulsion in ForceAtlas2
 * Folders get MUCH higher mass so they spread out and pull their files with them
 */
const getNodeMass = (nodeType: NodeLabel, _nodeCount: number): number => {
  // Mass affects FA2 repulsion — keep values moderate so clusters can form.
  // High mass on structural nodes prevents FA2 from pulling their children
  // into tight clusters, so we use a flatter scale.
  switch (nodeType) {
    case 'Project':
      return 10;
    case 'Package':
      return 6;
    case 'Module':
      return 5;
    case 'Folder':
      return 4;
    case 'File':
      return 2;
    case 'Class':
    case 'Interface':
      return 3;
    case 'Function':
    case 'Method':
      return 1;
    default:
      return 1;
  }
};

/**
 * Converts the KnowledgeGraph to a graphology Graph for Sigma.js
 * Folders are positioned in a wide spread, children positioned NEAR their parents
 * 
 * @param knowledgeGraph - The knowledge graph to convert
 * @param communityMemberships - Optional map of nodeId -> communityIndex for community coloring
 */
export const knowledgeGraphToGraphology = (
  knowledgeGraph: KnowledgeGraph,
  communityMemberships?: Map<string, number>
): MultiGraph<SigmaNodeAttributes, SigmaEdgeAttributes> => {
  const graph = new MultiGraph<SigmaNodeAttributes, SigmaEdgeAttributes>();
  const nodeCount = knowledgeGraph.nodes.length;

  // Skip metadata and structural container nodes — they're not code symbols
  // or have no semantic edges (Folder/Project/Package only had CONTAINS edges
  // which are excluded from the layout graph).
  const metadataTypes = new Set(['Community', 'Process', 'Project', 'Package', 'Module', 'Folder']);

  // Compact random initial positions — FA2 will organize from here.
  // Small spread lets FA2 expand clusters outward via repulsion.
  const spread = Math.sqrt(nodeCount);

  const symbolTypes = new Set(['Function', 'Class', 'Method', 'Interface', 'Enum', 'Type', 'Const']);

  for (const node of knowledgeGraph.nodes) {
    if (metadataTypes.has(node.label)) continue;

    const communityIndex = communityMemberships?.get(node.id);
    const hasCommunity = communityIndex !== undefined;
    const usesCommunityColor = hasCommunity && symbolTypes.has(node.label);
    const nodeColor = usesCommunityColor
      ? getCommunityColor(communityIndex!)
      : NODE_COLORS[node.label] || '#9ca3af';

    const baseSize = NODE_SIZES[node.label] || 8;
    const scaledSize = getScaledNodeSize(baseSize, nodeCount);

    graph.addNode(node.id, {
      x: (Math.random() - 0.5) * spread,
      y: (Math.random() - 0.5) * spread,
      size: scaledSize,
      color: nodeColor,
      label: node.properties.name,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      hidden: false,
      mass: getNodeMass(node.label, nodeCount),
      community: communityIndex,
      communityColor: hasCommunity ? getCommunityColor(communityIndex!) : undefined,
    });
  }

  // Add edges with distinct colors per relationship type
  const edgeBaseSize = nodeCount > 20000 ? 1.0 : nodeCount > 5000 ? 1.5 : 2.0;

  // Edge styles — bright colors on dark background, uniform sizing so all types are visible
  const EDGE_STYLES: Record<string, { color: string; sizeMultiplier: number }> = {
    CONTAINS: { color: '#4ade80', sizeMultiplier: 0.6 },    // Green
    DEFINES: { color: '#22d3ee', sizeMultiplier: 0.7 },     // Cyan
    IMPORTS: { color: '#60a5fa', sizeMultiplier: 0.8 },     // Blue
    CALLS: { color: '#a78bfa', sizeMultiplier: 0.8 },       // Purple
    HAS_METHOD: { color: '#2dd4bf', sizeMultiplier: 0.7 },  // Teal
    EXTENDS: { color: '#fb923c', sizeMultiplier: 1.0 },     // Orange
    IMPLEMENTS: { color: '#f472b6', sizeMultiplier: 0.9 },  // Pink
    SUBSCRIBES_TO: { color: '#fbbf24', sizeMultiplier: 0.8 }, // Yellow
    EMITS: { color: '#f87171', sizeMultiplier: 0.8 },       // Red
  };
  
  // Include edges that represent code relationships for FA2 layout.
  // DEFINES (File→Symbol) and HAS_METHOD (Class→Method) keep symbols near
  // their parent, while CALLS/IMPORTS create the inter-cluster structure.
  // Skip: CONTAINS (folder tree), MEMBER_OF (community metadata),
  // STEP_IN_PROCESS (execution flow metadata), FILE_CHANGES_WITH (git coupling).
  const includeForLayout = new Set([
    'CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS',
    'DEFINES', 'HAS_METHOD',
    'SUBSCRIBES_TO', 'EMITS',
  ]);

  knowledgeGraph.relationships.forEach((rel) => {
    if (!includeForLayout.has(rel.type)) return;
    if (!graph.hasNode(rel.sourceId) || !graph.hasNode(rel.targetId)) return;
    const style = EDGE_STYLES[rel.type] || { color: '#4a4a5a', sizeMultiplier: 0.5 };
    const curvature = 0.12 + (Math.random() * 0.08);

    graph.addEdge(rel.sourceId, rel.targetId, {
      size: edgeBaseSize * style.sizeMultiplier,
      color: style.color,
      relationType: rel.type,
      type: 'curved',
      curvature: curvature,
    });
  });

  // Remove isolated nodes (zero edges) — they add visual noise without
  // contributing to the graph structure. These are typically config files,
  // test fixtures, or other files with no imports/calls.
  const toRemove: string[] = [];
  graph.forEachNode((nodeId) => {
    if (graph.degree(nodeId) === 0) {
      toRemove.push(nodeId);
    }
  });
  for (const nodeId of toRemove) {
    graph.dropNode(nodeId);
  }

  return graph;
};

/**
 * Filter nodes by visibility - sets hidden attribute
 */
export const filterGraphByLabels = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  visibleLabels: NodeLabel[]
): void => {
  graph.forEachNode((nodeId, attributes) => {
    const isVisible = visibleLabels.includes(attributes.nodeType);
    graph.setNodeAttribute(nodeId, 'hidden', !isVisible);
  });
};

/**
 * Get all nodes within N hops of a starting node
 */
export const getNodesWithinHops = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  startNodeId: string,
  maxHops: number
): Set<string> => {
  const visited = new Set<string>();
  const queue: { nodeId: string; depth: number }[] = [{ nodeId: startNodeId, depth: 0 }];
  
  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;
    
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    
    if (depth < maxHops) {
      graph.forEachNeighbor(nodeId, (neighborId) => {
        if (!visited.has(neighborId)) {
          queue.push({ nodeId: neighborId, depth: depth + 1 });
        }
      });
    }
  }
  
  return visited;
};

/**
 * Filter nodes by depth from selected node
 */
export const filterGraphByDepth = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  selectedNodeId: string | null,
  maxHops: number | null,
  visibleLabels: NodeLabel[]
): void => {
  if (maxHops === null) {
    filterGraphByLabels(graph, visibleLabels);
    return;
  }
  
  if (selectedNodeId === null || !graph.hasNode(selectedNodeId)) {
    filterGraphByLabels(graph, visibleLabels);
    return;
  }
  
  const nodesInRange = getNodesWithinHops(graph, selectedNodeId, maxHops);
  
  graph.forEachNode((nodeId, attributes) => {
    const isLabelVisible = visibleLabels.includes(attributes.nodeType);
    const isInRange = nodesInRange.has(nodeId);
    graph.setNodeAttribute(nodeId, 'hidden', !isLabelVisible || !isInRange);
  });
};
