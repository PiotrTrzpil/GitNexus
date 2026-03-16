export type NodeLabel =
  | 'Project'
  | 'Package'
  | 'Module'
  | 'Folder'
  | 'File'
  | 'Class'
  | 'Function'
  | 'Method'
  | 'Variable'
  | 'Interface'
  | 'Enum'
  | 'Decorator'
  | 'Import'
  | 'Type'
  | 'CodeElement'
  | 'Community'
  | 'Process'
  // Multi-language node types
  | 'Struct'
  | 'Macro'
  | 'Typedef'
  | 'Union'
  | 'Namespace'
  | 'Trait'
  | 'Impl'
  | 'TypeAlias'
  | 'Const'
  | 'Static'
  | 'Property'
  | 'Record'
  | 'Delegate'
  | 'Annotation'
  | 'Constructor'
  | 'Template'
  | 'Parameter'
  // Intra-function control flow graph nodes
  | 'BasicBlock';


import { SupportedLanguages } from '../../config/supported-languages.js';

export type NodeProperties = {
  name: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
  language?: SupportedLanguages,
  isExported?: boolean,
  // Optional AST-derived framework hint (e.g. @Controller, @GetMapping)
  astFrameworkMultiplier?: number,
  astFrameworkReason?: string,
  // Community-specific properties
  heuristicLabel?: string,
  cohesion?: number,
  symbolCount?: number,
  keywords?: string[],
  description?: string,
  enrichedBy?: 'heuristic' | 'llm',
  // Process-specific properties
  processType?: 'intra_community' | 'cross_community',
  stepCount?: number,
  communities?: string[],
  entryPointId?: string,
  terminalId?: string,
  // Entry point scoring (computed by process detection)
  entryPointScore?: number,
  entryPointReason?: string,
  // Method signature (for MRO disambiguation)
  parameterCount?: number,
  returnType?: string,
  // ── Semantic depth properties ──
  /** Cyclomatic complexity (branching node count). Functions/Methods only. */
  complexity?: number,
  /** Source lines of code (endLine - startLine + 1). */
  sloc?: number,
  /** Visibility modifier. Class members only. */
  visibility?: 'public' | 'protected' | 'private',
  /** True for get/set accessors (as opposed to regular methods/properties). */
  isAccessor?: boolean,
  /** True for readonly/const fields. */
  isReadonly?: boolean,
  /** True for static members. */
  isStatic?: boolean,
  /** True for abstract methods/classes. */
  isAbstract?: boolean,
  // ── Parameter node properties (label: 'Parameter') ──
  /** Ordinal position in the parameter list (0-indexed). Parameter nodes only. */
  ordinal?: number,
  /** True if the parameter has `?` or a default value. Parameter nodes only. */
  isOptional?: boolean,
  /** True if the parameter has `= defaultValue`. Parameter nodes only. */
  hasDefault?: boolean,
  /** True if the parameter is a rest/spread param (`...args`). Parameter nodes only. */
  isRest?: boolean,
  // ── BasicBlock node properties (label: 'BasicBlock') ──
  /** Block ID within its function's CFG (0 = entry block). BasicBlock nodes only. */
  blockIndex?: number,
  /** Number of instructions in this block. BasicBlock nodes only. */
  instructionCount?: number,
  /** True if this block is statically unreachable. BasicBlock nodes only. */
  isUnreachable?: boolean,
  /** JSON-encoded instruction array (compact storage). BasicBlock nodes only. */
  cfgInstructions?: string,
}

export type RelationshipType =
  | 'CONTAINS'
  | 'CALLS'
  | 'INHERITS'
  | 'OVERRIDES'
  | 'IMPORTS'
  | 'USES'
  | 'DEFINES'
  | 'DECORATES'
  | 'IMPLEMENTS'
  | 'EXTENDS'
  | 'HAS_METHOD'
  | 'MEMBER_OF'
  | 'STEP_IN_PROCESS'
  | 'HTTP_CALLS'
  | 'ASYNC_CALLS'
  | 'EMITS'
  | 'SUBSCRIBES_TO'
  | 'FILE_CHANGES_WITH'
  | 'PARAM_OF'
  | 'READS_FIELD'
  | 'WRITES_FIELD'
  | 'USES_TYPE'
  | 'THROWS'
  // Intra-function control flow graph edges
  | 'CFG_CONTAINS'   // Function/Method → BasicBlock
  | 'CFG_EDGE'       // BasicBlock → BasicBlock

export interface GraphNode {
  id:  string,
  label: NodeLabel,
  properties: NodeProperties,  
}

export interface GraphRelationship {
  id: string,
  sourceId: string,
  targetId: string,
  type: RelationshipType,
  /** Confidence score 0-1 (1.0 = certain, lower = uncertain resolution) */
  confidence: number,
  /** Resolution reason: 'import-resolved', 'same-file', 'fuzzy-global', or empty for non-CALLS */
  reason: string,
  /** Step number for STEP_IN_PROCESS relationships (1-indexed) */
  step?: number,
  /** True when the call site is inside a branching construct. CALLS edges only. */
  isConditional?: boolean,
  /** Short guard expression text (e.g., "if (user.isAdmin)", "catch"). Truncated to 120 chars. CALLS edges only. */
  guardExpression?: string,
  /** Nesting depth of branching constructs around the call site. 0 = unconditional. CALLS edges only. */
  branchDepth?: number,
  /** CFG edge type: 'Jump' | 'Normal' | 'Backedge' | 'Finalize' | 'ErrorExplicit' | 'ErrorImplicit' | 'Unreachable' | 'Join'. CFG_EDGE relationships only. */
  cfgEdgeType?: string,
  /** Guard/condition expression text for Jump edges (≤120 chars). CFG_EDGE relationships only. */
  conditionText?: string,
}

export interface KnowledgeGraph {
  /** Returns a full array copy — prefer iterNodes() for iteration */
  nodes: GraphNode[],
  /** Returns a full array copy — prefer iterRelationships() for iteration */
  relationships: GraphRelationship[],
  /** Zero-copy iterator over nodes */
  iterNodes: () => IterableIterator<GraphNode>,
  /** Zero-copy iterator over relationships */
  iterRelationships: () => IterableIterator<GraphRelationship>,
  /** Zero-copy forEach — avoids iterator protocol overhead in hot loops */
  forEachNode: (fn: (node: GraphNode) => void) => void,
  forEachRelationship: (fn: (rel: GraphRelationship) => void) => void,
  /** Lookup a single node by id — O(1) */
  getNode: (id: string) => GraphNode | undefined,
  nodeCount: number,
  relationshipCount: number,
  addNode: (node: GraphNode) => void,
  addRelationship: (relationship: GraphRelationship) => void,
  removeNode: (nodeId: string) => boolean,
  removeNodesByFile: (filePath: string) => number,
}
