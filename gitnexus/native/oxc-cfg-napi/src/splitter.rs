//! Per-function CFG subgraph extraction.
//!
//! oxc builds a single whole-file CFG. This module splits it into per-function
//! subgraphs by traversing `NewFunction` edges, which mark transitions between
//! a function's body and its nested function declarations/expressions.
//!
//! # Algorithm
//!
//! 1. Start from the file's entry block (graph node index 0).
//! 2. BFS/DFS from each function entry block. When a `NewFunction` edge is
//!    encountered, record the target as a new function's entry block and do NOT
//!    continue traversal on that edge — each nested function is handled separately.
//! 3. Collect all reachable blocks within a function's subgraph (i.e., all blocks
//!    reachable without crossing a `NewFunction` edge).
//! 4. Collect all edges whose source AND target are both in the subgraph.
//! 5. Remap block IDs: the entry block becomes 0, all others get sequential IDs.

use std::collections::{HashMap, HashSet, VecDeque};

use oxc_cfg::{BasicBlockId, ControlFlowGraph, EdgeType};
use oxc_cfg::graph::prelude::{EdgeRef, NodeIndex};
use petgraph::Direction;

/// A raw per-function subgraph before mapping to NAPI types.
pub struct FunctionSubgraph {
    /// The CFG node index (in the whole-file graph) that is this function's entry block.
    pub entry_node: NodeIndex,
    /// All CFG node indices belonging to this function's subgraph, in BFS order.
    /// Entry block is always first.
    pub nodes: Vec<NodeIndex>,
    /// All edges within this function's subgraph.
    /// Stored as (source_node_index, target_node_index, edge_type).
    pub edges: Vec<(NodeIndex, NodeIndex, EdgeType)>,
    /// Mapping from whole-file node index → per-function block ID (0-indexed).
    pub node_to_local_id: HashMap<NodeIndex, u32>,
}

/// Entry point node indices for all nested function subgraphs discovered during
/// BFS of the containing function. These must be processed separately.
type NestedEntries = Vec<NodeIndex>;

impl FunctionSubgraph {
    /// Build a subgraph rooted at `entry_node` by BFS within the CFG.
    ///
    /// Stops at `NewFunction` edges — their targets are returned in the
    /// `nested_entries` vec for the caller to process independently.
    pub fn build(
        cfg: &ControlFlowGraph,
        entry_node: NodeIndex,
    ) -> (FunctionSubgraph, NestedEntries) {
        let graph = &cfg.graph;
        let mut visited: HashSet<NodeIndex> = HashSet::new();
        let mut queue: VecDeque<NodeIndex> = VecDeque::new();
        let mut nodes_in_order: Vec<NodeIndex> = Vec::new();
        let mut nested_entries: Vec<NodeIndex> = Vec::new();
        let mut edges: Vec<(NodeIndex, NodeIndex, EdgeType)> = Vec::new();

        visited.insert(entry_node);
        queue.push_back(entry_node);

        while let Some(node) = queue.pop_front() {
            nodes_in_order.push(node);

            for edge_ref in graph.edges_directed(node, Direction::Outgoing) {
                let edge_weight = edge_ref.weight();
                let target = edge_ref.target();

                match edge_weight {
                    EdgeType::NewFunction => {
                        // Do not traverse into nested functions — record the entry
                        // for independent processing, but don't add the edge to this
                        // subgraph.
                        if !nested_entries.contains(&target) {
                            nested_entries.push(target);
                        }
                    }
                    _ => {
                        // Collect this edge as part of the current function's subgraph.
                        // We'll filter later to only include edges with both endpoints in
                        // the final node set.
                        if !visited.contains(&target) {
                            visited.insert(target);
                            queue.push_back(target);
                        }
                        edges.push((node, target, edge_weight.clone()));
                    }
                }
            }
        }

        // Filter edges: only keep edges where both source and target are in this subgraph.
        // (This handles back-edges and any other cross-edges that might reference nodes
        // outside the subgraph due to graph structure.)
        let node_set: HashSet<NodeIndex> = nodes_in_order.iter().copied().collect();
        let edges: Vec<(NodeIndex, NodeIndex, EdgeType)> = edges
            .into_iter()
            .filter(|(src, tgt, _)| node_set.contains(src) && node_set.contains(tgt))
            .collect();

        // Build the local ID mapping: entry block → 0, then BFS order.
        let mut node_to_local_id: HashMap<NodeIndex, u32> = HashMap::new();
        for (local_id, &node_idx) in nodes_in_order.iter().enumerate() {
            node_to_local_id.insert(node_idx, local_id as u32);
        }

        let subgraph = FunctionSubgraph {
            entry_node,
            nodes: nodes_in_order,
            edges,
            node_to_local_id,
        };

        (subgraph, nested_entries)
    }

    /// Convert a whole-file node index to a per-function local block ID.
    /// Panics if the node is not part of this subgraph.
    #[inline]
    pub fn local_id(&self, node: NodeIndex) -> u32 {
        *self.node_to_local_id.get(&node).expect(
            "node_to_local_id lookup failed: node not in this function subgraph"
        )
    }
}

/// Split the whole-file CFG into per-function subgraphs.
///
/// Returns a list of `(entry_node, subgraph)` pairs. The first entry is always
/// the top-level file scope (entry block 0 of the whole-file graph). Nested
/// function entries follow in discovery order (BFS order from root).
///
/// # Arguments
///
/// * `cfg` - The whole-file control flow graph from oxc semantic analysis.
/// * `function_entries` - Additional known entry block node indices for named/arrow
///   functions (obtained via `semantic.nodes().cfg_id(node_id)` for each function
///   AST node). These are used to seed the BFS — any entry that wasn't reached via
///   `NewFunction` edges from the top-level will still be processed.
pub fn split_into_function_subgraphs(
    cfg: &ControlFlowGraph,
    extra_entries: &[NodeIndex],
) -> Vec<(NodeIndex, FunctionSubgraph)> {
    let graph = &cfg.graph;

    // The file-level entry is always node index 0 in petgraph's DiGraph.
    // oxc creates the entry block first when building the CFG.
    let file_entry = NodeIndex::new(0);

    // We use a work queue seeded with the file entry node. As we process each
    // function, we discover nested function entries via NewFunction edges and
    // add them to the queue.
    let mut work_queue: VecDeque<NodeIndex> = VecDeque::new();
    let mut processed: HashSet<NodeIndex> = HashSet::new();
    let mut results: Vec<(NodeIndex, FunctionSubgraph)> = Vec::new();

    // Seed with the file-level entry first.
    if graph.node_weight(file_entry).is_some() {
        work_queue.push_back(file_entry);
    }

    // Also seed with any extra entries provided by the caller (function AST nodes
    // that may not be reachable via NewFunction from the top-level — e.g., if the
    // graph structure differs from expectations).
    for &entry in extra_entries {
        if graph.node_weight(entry).is_some() && !work_queue.contains(&entry) {
            work_queue.push_back(entry);
        }
    }

    while let Some(entry_node) = work_queue.pop_front() {
        if processed.contains(&entry_node) {
            continue;
        }
        processed.insert(entry_node);

        let (subgraph, nested_entries) = FunctionSubgraph::build(cfg, entry_node);

        // Enqueue discovered nested function entries.
        for nested in nested_entries {
            if !processed.contains(&nested) {
                work_queue.push_back(nested);
            }
        }

        results.push((entry_node, subgraph));
    }

    results
}

/// Look up the `BasicBlockId` (the semantic-level ID stored as a node weight in
/// the DiGraph) for a given petgraph `NodeIndex`.
///
/// Returns `None` if the node index is not valid.
pub fn node_index_to_basic_block_id(
    cfg: &ControlFlowGraph,
    node_idx: NodeIndex,
) -> Option<BasicBlockId> {
    cfg.graph.node_weight(node_idx).copied()
}

/// Given a `BlockNodeId` (which is a `petgraph::stable_graph::NodeIndex`), find
/// the corresponding `petgraph::graph::NodeIndex` in the DiGraph.
///
/// `oxc_cfg::BlockNodeId` is a `stable_graph::NodeIndex` used by the semantic
/// builder for node lookup. However, `cfg.graph` is a `DiGraph` (not a
/// `StableGraph`), so the indices are structurally the same (both `u32`-backed)
/// but typed differently. We convert by raw index value.
///
/// This works because oxc's CFG is built without removing nodes, so the DiGraph
/// and conceptual stable indices stay in sync.
#[inline]
pub fn block_node_id_to_node_index(block_node_id: oxc_cfg::BlockNodeId) -> NodeIndex {
    NodeIndex::new(block_node_id.index())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unit tests for LineIndex and text extraction are in text.rs.
    // Functional tests for subgraph splitting require a real CFG and are in
    // the integration test suite.

    #[test]
    fn test_block_node_id_conversion() {
        use oxc_cfg::BlockNodeId;

        // petgraph::stable_graph::NodeIndex and petgraph::graph::NodeIndex both
        // use .index() to get the raw usize. Verify the conversion is identity.
        let stable_idx = BlockNodeId::new(42);
        let graph_idx = block_node_id_to_node_index(stable_idx);
        assert_eq!(graph_idx.index(), 42);
    }
}
