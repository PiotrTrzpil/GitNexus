//! NAPI binding: oxc-based control flow graph analysis for GitNexus.
//!
//! Exposes a single synchronous function `analyze_cfg(filename, source_code, options?)`
//! that parses a TypeScript/JavaScript file using oxc, runs semantic analysis with
//! CFG construction enabled, splits the whole-file CFG into per-function subgraphs,
//! and returns structured JS objects describing each function's basic blocks and
//! control flow edges.
//!
//! # Usage (from JS/TS)
//!
//! ```typescript
//! const { analyzeCfg } = require('@gitnexus/oxc-cfg');
//! const result = analyzeCfg('src/auth.ts', sourceCode);
//! // result: { functions: FunctionCfg[], errors: CfgError[] }
//! ```

#![allow(clippy::module_inception)]

mod splitter;
mod text;

use std::path::Path;

use napi_derive::napi;
use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_cfg::{
    BasicBlockId, ControlFlowGraph, EdgeType, ErrorEdgeKind, InstructionKind, ReturnInstructionKind,
};
use oxc_parser::Parser;
use oxc_semantic::{AstNodes, NodeId as AstNodeId, SemanticBuilder};
use oxc_span::{GetSpan, SourceType};

use splitter::{
    block_node_id_to_node_index, node_index_to_basic_block_id, split_into_function_subgraphs,
    FunctionSubgraph,
};
use text::{extract_condition_text, extract_instruction_text, LineIndex};

// ── NAPI struct definitions ───────────────────────────────────────────────────
// These must exactly match the contracts in the design doc and index.d.ts.

#[napi(object)]
pub struct CfgAnalysisResult {
    pub functions: Vec<FunctionCfg>,
    pub errors: Vec<CfgError>,
}

#[napi(object)]
pub struct CfgError {
    pub message: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[napi(object)]
pub struct FunctionCfg {
    pub name: String,
    pub start_line: u32,
    pub end_line: u32,
    pub class_name: Option<String>,
    pub blocks: Vec<CfgBlock>,
    pub edges: Vec<CfgEdge>,
}

#[napi(object)]
pub struct CfgBlock {
    pub id: u32,
    pub instructions: Vec<CfgInstruction>,
    pub unreachable: bool,
}

#[napi(object)]
pub struct CfgInstruction {
    pub kind: String,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub start_column: Option<u32>,
    pub end_column: Option<u32>,
    pub text: Option<String>,
}

#[napi(object)]
pub struct CfgEdge {
    pub source: u32,
    pub target: u32,
    #[napi(js_name = "type")]
    pub edge_type: String,
    pub condition_text: Option<String>,
}

#[napi(object)]
pub struct CfgOptions {
    /// Source type override. Default: inferred from filename extension.
    /// Accepted values: "typescript" | "javascript" | "tsx" | "jsx"
    pub source_type: Option<String>,
    /// Include instruction text for Statement instructions (default: false).
    pub include_statement_text: Option<bool>,
    /// Max functions to analyze per file (default: 500 — safety valve for generated code).
    pub max_functions: Option<u32>,
}

// ── Internal intermediate types ───────────────────────────────────────────────

/// All information about a function node extracted from the AST, before
/// looking up its CFG subgraph.
struct FunctionInfo {
    name: String,
    start_line: u32,
    end_line: u32,
    class_name: Option<String>,
    /// The entry `NodeIndex` (petgraph::graph::NodeIndex) for this function in the CFG.
    /// Obtained by converting `semantic.nodes().cfg_id(node_id)` → NodeIndex.
    entry_node: oxc_cfg::graph::prelude::NodeIndex,
}

/// Analysis context threaded through block/edge building functions.
struct AnalysisContext<'a> {
    source_code: &'a str,
    line_index: &'a LineIndex,
    ast_nodes: &'a AstNodes<'a>,
    include_statement_text: bool,
}

// ── Main NAPI entry point ─────────────────────────────────────────────────────

/// Analyze a TypeScript/JavaScript file and return per-function control flow graphs.
///
/// This is the single synchronous entry point called from the parse worker thread.
/// It is stateless — each call performs a complete parse + semantic analysis from scratch.
///
/// # Arguments
///
/// * `filename` — File path (used to infer source type if `options.source_type` is not set).
/// * `source_code` — Full source text of the file.
/// * `options` — Optional configuration.
///
/// # Returns
///
/// A `CfgAnalysisResult` containing:
/// - `functions`: Per-function CFG data (blocks + edges).
/// - `errors`: Non-fatal parse/semantic errors. Partial results may still be present.
#[napi]
pub fn analyze_cfg(
    filename: String,
    source_code: String,
    options: Option<CfgOptions>,
) -> CfgAnalysisResult {
    let opts = options.unwrap_or(CfgOptions {
        source_type: None,
        include_statement_text: None,
        max_functions: None,
    });

    let max_functions = opts.max_functions.unwrap_or(500) as usize;
    let include_statement_text = opts.include_statement_text.unwrap_or(false);

    // Determine source type from filename extension or explicit override.
    let source_type = resolve_source_type(&filename, opts.source_type.as_deref());

    // Build line index for span → line/col conversion.
    let line_index = LineIndex::new(&source_code);

    // Parse the source. oxc's allocator is an arena — all AST nodes live here.
    let allocator = Allocator::default();
    let parse_result = Parser::new(&allocator, &source_code, source_type).parse();

    // Collect parse errors (non-fatal — oxc recovers and continues).
    let mut errors: Vec<CfgError> = parse_result
        .errors
        .iter()
        .map(|e| {
            let span_offset = e
                .labels
                .as_ref()
                .and_then(|v| v.first())
                .map(|l| l.offset() as u32)
                .unwrap_or(0);
            let (start_line, _) = line_index.offset_to_line_col(span_offset);
            CfgError {
                message: e.message.to_string(),
                start_line,
                end_line: start_line,
            }
        })
        .collect();

    // If the parser aborted entirely (panic_mode), return early with errors only.
    if parse_result.panicked {
        return CfgAnalysisResult { functions: vec![], errors };
    }

    // Run semantic analysis with CFG enabled.
    let semantic_result = SemanticBuilder::new()
        .with_cfg(true)
        .build(&parse_result.program);

    // Collect semantic errors.
    for diag in &semantic_result.errors {
        let span_offset = diag
            .labels
            .as_ref()
            .and_then(|v| v.first())
            .map(|l| l.offset() as u32)
            .unwrap_or(0);
        let (start_line, _) = line_index.offset_to_line_col(span_offset);
        errors.push(CfgError {
            message: diag.message.to_string(),
            start_line,
            end_line: start_line,
        });
    }

    let semantic = semantic_result.semantic;

    // Retrieve the CFG. If not present (shouldn't happen with with_cfg(true), but be safe).
    let cfg = match semantic.cfg() {
        Some(c) => c,
        None => {
            errors.push(CfgError {
                message: "CFG not constructed — semantic builder may have failed".to_string(),
                start_line: 0,
                end_line: 0,
            });
            return CfgAnalysisResult { functions: vec![], errors };
        }
    };

    let ctx = AnalysisContext {
        source_code: &source_code,
        line_index: &line_index,
        ast_nodes: semantic.nodes(),
        include_statement_text,
    };

    // --- Step 1: Collect function AST nodes with their CFG entry blocks ---
    let function_infos = collect_function_infos(ctx.ast_nodes, cfg, &source_code, &line_index);

    // --- Step 2: Split the whole-file CFG into per-function subgraphs ---
    // We provide the entry node indices from function_infos as extra seeds so that
    // any function not reachable via NewFunction edges from the top-level is still
    // processed.
    let extra_entries: Vec<oxc_cfg::graph::prelude::NodeIndex> =
        function_infos.iter().map(|fi| fi.entry_node).collect();

    let subgraphs = split_into_function_subgraphs(cfg, &extra_entries);

    // Build a map from entry_node → FunctionInfo for O(1) lookup.
    let mut entry_to_info: std::collections::HashMap<
        oxc_cfg::graph::prelude::NodeIndex,
        usize, // index into function_infos
    > = std::collections::HashMap::new();
    for (idx, fi) in function_infos.iter().enumerate() {
        // If two functions share the same entry node (shouldn't happen normally),
        // prefer the first one encountered.
        entry_to_info.entry(fi.entry_node).or_insert(idx);
    }

    // --- Step 3: Map subgraphs to NAPI FunctionCfg structs ---
    let mut functions: Vec<FunctionCfg> = Vec::new();

    for (entry_node, subgraph) in &subgraphs {
        if functions.len() >= max_functions {
            break;
        }

        // Look up the FunctionInfo for this entry, or synthesize one for top-level code.
        let (name, start_line, end_line, class_name) = if let Some(&info_idx) =
            entry_to_info.get(entry_node)
        {
            let fi = &function_infos[info_idx];
            (
                fi.name.clone(),
                fi.start_line,
                fi.end_line,
                fi.class_name.clone(),
            )
        } else {
            // No FunctionInfo found: this is the file-level top-level scope.
            let (total_lines, _) = if !source_code.is_empty() {
                line_index.offset_to_line_col(source_code.len() as u32 - 1)
            } else {
                (1, 1)
            };
            ("<top-level>".to_string(), 1, total_lines, None)
        };

        let blocks = build_blocks(cfg, subgraph, &ctx);
        let edges = build_edges(cfg, subgraph, &ctx);

        functions.push(FunctionCfg {
            name,
            start_line,
            end_line,
            class_name,
            blocks,
            edges,
        });
    }

    CfgAnalysisResult { functions, errors }
}

// ── Helper: source type resolution ────────────────────────────────────────────

fn resolve_source_type(filename: &str, override_type: Option<&str>) -> SourceType {
    if let Some(st) = override_type {
        match st {
            "typescript" => return SourceType::ts(),
            "tsx" => return SourceType::tsx(),
            "javascript" => return SourceType::mjs(),
            "jsx" => return SourceType::jsx(),
            _ => {} // fall through to extension-based detection
        }
    }

    // Infer from file extension.
    let path = Path::new(filename);
    SourceType::from_path(path).unwrap_or_else(|_| SourceType::ts())
}

// ── Helper: collect function info from AST ────────────────────────────────────

fn collect_function_infos<'a>(
    nodes: &'a AstNodes<'a>,
    cfg: &ControlFlowGraph,
    source_code: &str,
    line_index: &LineIndex,
) -> Vec<FunctionInfo> {
    let _ = source_code; // used by sub-helpers if needed
    let mut infos: Vec<FunctionInfo> = Vec::new();

    for node in nodes.iter() {
        let kind = node.kind();

        match kind {
            AstKind::Function(func) => {
                let span = func.span;
                let (start_line, _) = line_index.offset_to_line_col(span.start);
                let (end_line, _) = line_index.offset_to_line_col(span.end.saturating_sub(1));

                let node_id = func.node_id.get();

                // Try to extract the function name directly.
                let func_name_opt = func.id.as_ref().map(|id| id.name.as_str().to_string());

                // Look up the parent to determine if this is a method or class context.
                let (class_name, method_name) = get_class_and_method_name(nodes, node_id);

                let name = if let Some(mn) = method_name {
                    mn
                } else if let Some(fn_name) = func_name_opt {
                    fn_name
                } else {
                    // Anonymous function — generate a name from its start line.
                    format!("anonymous@{}", start_line)
                };

                // Get the CFG entry block for this function node.
                let block_node_id = nodes.cfg_id(node_id);
                let entry_node = block_node_id_to_node_index(block_node_id);

                // Only add if the entry node exists in the graph.
                if cfg.graph.node_weight(entry_node).is_some() {
                    infos.push(FunctionInfo {
                        name,
                        start_line,
                        end_line,
                        class_name,
                        entry_node,
                    });
                }
            }

            AstKind::ArrowFunctionExpression(arrow) => {
                let span = arrow.span;
                let (start_line, _) = line_index.offset_to_line_col(span.start);
                let (end_line, _) = line_index.offset_to_line_col(span.end.saturating_sub(1));

                let node_id = arrow.node_id.get();

                // Try to infer a name from the parent context (e.g., `const foo = () => {}`).
                let name = get_arrow_function_name(nodes, node_id, start_line);
                let (class_name, _) = get_class_and_method_name(nodes, node_id);

                let block_node_id = nodes.cfg_id(node_id);
                let entry_node = block_node_id_to_node_index(block_node_id);

                if cfg.graph.node_weight(entry_node).is_some() {
                    infos.push(FunctionInfo {
                        name,
                        start_line,
                        end_line,
                        class_name,
                        entry_node,
                    });
                }
            }

            _ => {}
        }
    }

    infos
}

/// Walk up the AST ancestors from a function node to determine if it is a class
/// method and extract the class name and method name.
///
/// Returns `(class_name, method_name)` where either may be None.
fn get_class_and_method_name<'a>(
    nodes: &'a AstNodes<'a>,
    node_id: AstNodeId,
) -> (Option<String>, Option<String>) {
    let mut class_name: Option<String> = None;
    let mut method_name: Option<String> = None;

    // Walk ancestors: Function → FunctionExpression context → MethodDefinition → ClassBody → Class
    for ancestor_kind in nodes.ancestor_kinds(node_id) {
        match ancestor_kind {
            AstKind::MethodDefinition(method_def) => {
                method_name = property_key_name(&method_def.key);
            }
            AstKind::Class(class) => {
                class_name = class
                    .id
                    .as_ref()
                    .map(|id| id.name.as_str().to_string());
                // Stop walking once we've found the enclosing class.
                break;
            }
            _ => {}
        }
    }

    (class_name, method_name)
}

/// Extract a string name from a `PropertyKey`.
fn property_key_name(key: &oxc_ast::ast::PropertyKey<'_>) -> Option<String> {
    match key {
        oxc_ast::ast::PropertyKey::StaticIdentifier(id) => {
            Some(id.name.as_str().to_string())
        }
        oxc_ast::ast::PropertyKey::PrivateIdentifier(priv_id) => {
            Some(format!("#{}", priv_id.name.as_str()))
        }
        // Expression variants (string/number literals as computed keys)
        _ => {
            // Try to match against common Expression variants that might embed literals.
            // These are added via the @inherit macro, so we match by the enum discriminant
            // approach — just return None for complex/computed keys.
            None
        }
    }
}

/// Attempt to infer a name for an arrow function from its surrounding context.
///
/// Common cases:
/// - `const foo = () => {}` → "foo"
/// - `let bar = async () => {}` → "bar"
/// - Otherwise → "anonymous@{line}"
fn get_arrow_function_name<'a>(
    nodes: &'a AstNodes<'a>,
    node_id: AstNodeId,
    start_line: u32,
) -> String {
    // Check ancestors: VariableDeclarator or PropertyDefinition often hold arrow functions.
    for ancestor_kind in nodes.ancestor_kinds(node_id) {
        match ancestor_kind {
            AstKind::VariableDeclarator(decl) => {
                // `const foo = () => {}`
                if let oxc_ast::ast::BindingPattern::BindingIdentifier(id) = &decl.id {
                    return id.name.as_str().to_string();
                }
                break;
            }
            AstKind::PropertyDefinition(prop_def) => {
                // Class property: `foo = () => {}`
                if let Some(name) = property_key_name(&prop_def.key) {
                    return name;
                }
                break;
            }
            AstKind::ObjectProperty(obj_prop) => {
                // Object literal method shorthand: `{ foo: () => {} }`
                if let Some(name) = property_key_name(&obj_prop.key) {
                    return name;
                }
                break;
            }
            AstKind::Function(_)
            | AstKind::ArrowFunctionExpression(_)
            | AstKind::MethodDefinition(_) => {
                // Nested inside another function context — stop looking up.
                break;
            }
            _ => {}
        }
    }

    format!("anonymous@{}", start_line)
}

// ── Helper: build CfgBlock list from subgraph ─────────────────────────────────

fn build_blocks(
    cfg: &ControlFlowGraph,
    subgraph: &FunctionSubgraph,
    ctx: &AnalysisContext<'_>,
) -> Vec<CfgBlock> {
    let mut blocks: Vec<CfgBlock> = Vec::with_capacity(subgraph.nodes.len());

    for &node_idx in &subgraph.nodes {
        let local_id = subgraph.local_id(node_idx);

        // Get the BasicBlockId from the graph node weight, then look up the BasicBlock.
        let bb_id: BasicBlockId = match node_index_to_basic_block_id(cfg, node_idx) {
            Some(id) => id,
            None => {
                // Malformed graph — add an empty placeholder block and continue.
                blocks.push(CfgBlock {
                    id: local_id,
                    instructions: vec![],
                    unreachable: false,
                });
                continue;
            }
        };

        let basic_block = &cfg.basic_blocks[bb_id];
        let unreachable = basic_block.is_unreachable();

        let instructions: Vec<CfgInstruction> = basic_block
            .instructions()
            .iter()
            .map(|instr| build_instruction(instr, ctx))
            .collect();

        blocks.push(CfgBlock {
            id: local_id,
            instructions,
            unreachable,
        });
    }

    blocks
}

/// Convert an oxc `Instruction` to a `CfgInstruction` NAPI struct.
fn build_instruction(
    instr: &oxc_cfg::Instruction,
    ctx: &AnalysisContext<'_>,
) -> CfgInstruction {
    use InstructionKind::*;

    let kind_str = match &instr.kind {
        Statement => "Statement",
        Condition => "Condition",
        Return(_) => "Return",
        ImplicitReturn => "ImplicitReturn",
        Break(_) => "Break",
        Continue(_) => "Continue",
        Throw => "Throw",
        Iteration(_) => "Iteration",
        Unreachable => "Unreachable",
    }
    .to_string();

    // Extract source location and text from the AST node if present.
    let (start_line, end_line, start_col, end_col, text) =
        if let Some(node_id) = instr.node_id {
            let ast_node = ctx.ast_nodes.get_node(node_id);
            let span = ast_node.span();
            let (sl, sc) = ctx.line_index.offset_to_line_col(span.start);
            let (el, ec) = ctx.line_index.offset_to_line_col(span.end.saturating_sub(1));

            // Extract text for Condition, Return, and Throw instructions.
            // Statement text is controlled by the `include_statement_text` option.
            let text = match &instr.kind {
                Condition => {
                    extract_condition_text(ctx.source_code, span)
                }
                Return(kind) => {
                    match kind {
                        ReturnInstructionKind::NotImplicitUndefined => {
                            extract_instruction_text(ctx.source_code, span)
                        }
                        ReturnInstructionKind::ImplicitUndefined => None,
                    }
                }
                Throw => extract_instruction_text(ctx.source_code, span),
                Statement => {
                    if ctx.include_statement_text {
                        extract_instruction_text(ctx.source_code, span)
                    } else {
                        None
                    }
                }
                _ => None,
            };

            (Some(sl), Some(el), Some(sc), Some(ec), text)
        } else {
            (None, None, None, None, None)
        };

    CfgInstruction {
        kind: kind_str,
        start_line,
        end_line,
        start_column: start_col,
        end_column: end_col,
        text,
    }
}

// ── Helper: build CfgEdge list from subgraph ──────────────────────────────────

fn build_edges(
    cfg: &ControlFlowGraph,
    subgraph: &FunctionSubgraph,
    ctx: &AnalysisContext<'_>,
) -> Vec<CfgEdge> {
    let mut edges: Vec<CfgEdge> = Vec::with_capacity(subgraph.edges.len());

    for (src_node, tgt_node, edge_type) in &subgraph.edges {
        let source_local = subgraph.local_id(*src_node);
        let target_local = subgraph.local_id(*tgt_node);

        let (edge_type_str, condition_text) =
            convert_edge_type(edge_type, cfg, src_node, ctx);

        edges.push(CfgEdge {
            source: source_local,
            target: target_local,
            edge_type: edge_type_str,
            condition_text,
        });
    }

    edges
}

/// Convert an `EdgeType` to a string label and extract condition text for Jump edges.
///
/// For `Jump` edges, we walk the source block's instructions to find a `Condition`
/// instruction, then extract its source text via AST span lookup.
fn convert_edge_type(
    edge_type: &EdgeType,
    cfg: &ControlFlowGraph,
    src_node: &oxc_cfg::graph::prelude::NodeIndex,
    ctx: &AnalysisContext<'_>,
) -> (String, Option<String>) {
    match edge_type {
        EdgeType::Jump => {
            let condition_text = find_condition_text_for_jump(cfg, src_node, ctx);
            ("Jump".to_string(), condition_text)
        }
        EdgeType::Normal => ("Normal".to_string(), None),
        EdgeType::Backedge => ("Backedge".to_string(), None),
        // NewFunction edges are filtered out during subgraph splitting and should
        // not appear here. Emit defensively rather than panicking.
        EdgeType::NewFunction => ("NewFunction".to_string(), None),
        EdgeType::Finalize => ("Finalize".to_string(), None),
        EdgeType::Error(ErrorEdgeKind::Explicit) => ("ErrorExplicit".to_string(), None),
        EdgeType::Error(ErrorEdgeKind::Implicit) => ("ErrorImplicit".to_string(), None),
        EdgeType::Unreachable => ("Unreachable".to_string(), None),
        EdgeType::Join => ("Join".to_string(), None),
    }
}

/// Walk the source block of a Jump edge backwards to find the condition instruction's
/// source text.
///
/// Design: For Jump edges, the source block should contain a `Condition` instruction
/// as its last meaningful instruction. We search for it in reverse and extract the
/// AST node span to get the condition expression text.
///
/// This is the heuristic described in the design doc § Condition text extraction,
/// compensating for `EdgeType::Jump` not carrying a condition node ID (see
/// § Hints for Upstream oxc_cfg Modifications §3 for the upstream improvement).
fn find_condition_text_for_jump(
    cfg: &ControlFlowGraph,
    src_node: &oxc_cfg::graph::prelude::NodeIndex,
    ctx: &AnalysisContext<'_>,
) -> Option<String> {
    let bb_id = node_index_to_basic_block_id(cfg, *src_node)?;
    let basic_block = &cfg.basic_blocks[bb_id];

    // Find the last Condition instruction in this block.
    for instr in basic_block.instructions().iter().rev() {
        if matches!(instr.kind, InstructionKind::Condition) {
            if let Some(node_id) = instr.node_id {
                // Look up the AST node to get its span.
                let ast_node = ctx.ast_nodes.get_node(node_id);
                let span = ast_node.span();
                return extract_condition_text(ctx.source_code, span);
            }
        }
    }

    None
}
