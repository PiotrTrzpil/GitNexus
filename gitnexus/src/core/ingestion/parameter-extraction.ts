/**
 * parameter-extraction.ts
 *
 * Extracts Parameter nodes from function/method/constructor AST nodes.
 * Returns ExtractedParameter records (one per parameter) along with
 * any promoted Property nodes (TypeScript constructor parameter promotion).
 *
 * This module is a pure helper — it does not touch the graph or worker state.
 * The parse worker (parse-worker.ts) calls these helpers inside its definition
 * extraction loop and appends the results to ParseWorkerResult.parameters.
 */

import type { SyntaxNode } from './utils.js';
import { generateId } from '../../lib/utils.js';
import { extractSimpleTypeName, extractVarName } from './type-extractors/shared.js';

// ── Shared contract types (mirrors design doc's Shared Contracts section) ────

export interface ExtractedParameter {
  filePath: string;
  /** generateId('Parameter', `${filePath}:${funcName}:${paramName}`) */
  id: string;
  /** ID of the parent function/method/constructor node */
  parentId: string;
  name: string;
  startLine: number;
  endLine: number;
  ordinal: number;
  /** Resolved type name (from annotation). Undefined when no type annotation present. */
  type?: string;
  isOptional: boolean;
  hasDefault: boolean;
  isRest: boolean;
  /** TypeScript constructor parameter promotion visibility modifier */
  visibility?: 'public' | 'protected' | 'private';
}

/**
 * A promoted property created alongside a Parameter node for TS constructor promotion.
 * e.g. `constructor(private name: string)` creates both a Parameter node and a Property node.
 */
export interface PromotedProperty {
  filePath: string;
  /** generateId('Property', `${filePath}:${className}:${paramName}`) */
  id: string;
  /** ID of the enclosing class node */
  classId: string;
  name: string;
  startLine: number;
  endLine: number;
  type?: string;
  visibility: 'public' | 'protected' | 'private';
  isReadonly: boolean;
}

export interface ParameterExtractionResult {
  parameters: ExtractedParameter[];
  /** Promoted Property nodes from TypeScript constructor parameter promotion */
  promotedProperties: PromotedProperty[];
}

// ── TypeScript/JavaScript parameter node type sets ───────────────────────────

/**
 * AST node types that represent a single parameter in TS/JS parameter lists.
 */
const TS_PARAM_NODE_TYPES = new Set([
  'required_parameter',
  'optional_parameter',
]);

/**
 * AST node types that represent parameter lists (the container node).
 */
const PARAM_LIST_NODE_TYPES = new Set([
  'formal_parameters',
  'parameters',
  'parameter_list',
  'function_parameters',
  'method_parameters',
  'function_value_parameters',
]);

// ── Visibility extraction helpers ─────────────────────────────────────────────

const VISIBILITY_KEYWORDS = new Set(['public', 'private', 'protected']);

/**
 * Extract a TypeScript visibility modifier from a parameter node.
 * For constructor promotion: `constructor(private name: string)` → 'private'.
 * Returns undefined when no accessibility modifier is present.
 */
const extractVisibilityFromParam = (
  paramNode: SyntaxNode,
): 'public' | 'protected' | 'private' | undefined => {
  // TypeScript tree-sitter: accessibility_modifier is a named child of required_parameter
  // or optional_parameter for constructor-promoted parameters.
  for (let i = 0; i < paramNode.namedChildCount; i++) {
    const child = paramNode.namedChild(i);
    if (!child) continue;
    if (child.type === 'accessibility_modifier') {
      const text = child.text as 'public' | 'protected' | 'private';
      if (VISIBILITY_KEYWORDS.has(text)) return text;
    }
  }
  // Also check non-named children (accessibility modifier may be an anonymous node)
  for (let i = 0; i < paramNode.childCount; i++) {
    const child = paramNode.child(i);
    if (!child) continue;
    if (child.type === 'accessibility_modifier') {
      const text = child.text as 'public' | 'protected' | 'private';
      if (VISIBILITY_KEYWORDS.has(text)) return text;
    }
    // Some grammars emit the keyword directly as a named child
    if (VISIBILITY_KEYWORDS.has(child.text) && !child.isNamed) {
      const kw = child.text as 'public' | 'protected' | 'private';
      return kw;
    }
  }
  return undefined;
};

/**
 * Check whether a parameter node has a `readonly` modifier.
 * TypeScript constructor promotion: `constructor(readonly id: string)`.
 */
const hasReadonlyModifier = (paramNode: SyntaxNode): boolean => {
  for (let i = 0; i < paramNode.childCount; i++) {
    const child = paramNode.child(i);
    if (child && (child.type === 'readonly' || child.text === 'readonly')) return true;
  }
  return false;
};

// ── Parameter name extraction ─────────────────────────────────────────────────

/**
 * Extract the plain parameter name from a TS/JS parameter node.
 * Handles required_parameter, optional_parameter, and fallback patterns.
 * Returns undefined for destructuring patterns (object/array).
 */
const extractParamName = (paramNode: SyntaxNode): string | undefined => {
  // TS: required_parameter and optional_parameter expose a 'pattern' or 'name' field
  const patternNode =
    paramNode.childForFieldName('pattern') ??
    paramNode.childForFieldName('name');

  if (patternNode) {
    // Unwrap rest_pattern: ...args → identifier 'args'
    if (patternNode.type === 'rest_pattern') {
      const inner = patternNode.firstNamedChild;
      return inner ? extractVarName(inner) : undefined;
    }
    return extractVarName(patternNode);
  }

  // Fallback: first identifier-like named child
  for (let i = 0; i < paramNode.namedChildCount; i++) {
    const child = paramNode.namedChild(i);
    if (!child) continue;
    // Skip modifier nodes
    if (
      child.type === 'accessibility_modifier' ||
      child.type === 'type_annotation' ||
      child.type === 'readonly' ||
      VISIBILITY_KEYWORDS.has(child.text)
    ) {
      continue;
    }
    if (child.type === 'rest_pattern') {
      const inner = child.firstNamedChild;
      return inner ? extractVarName(inner) : undefined;
    }
    const name = extractVarName(child);
    if (name) return name;
  }

  return undefined;
};

// ── Rest/spread detection ─────────────────────────────────────────────────────

/**
 * Returns true if this parameter is a rest/spread param (`...args`).
 * Works for TS/JS required_parameter wrapping a rest_pattern, and bare rest_pattern nodes.
 */
const isRestParam = (paramNode: SyntaxNode): boolean => {
  if (paramNode.type === 'rest_pattern') return true;

  const patternNode =
    paramNode.childForFieldName('pattern') ??
    paramNode.childForFieldName('name');
  if (patternNode?.type === 'rest_pattern') return true;

  // Check all children for rest_pattern
  for (let i = 0; i < paramNode.childCount; i++) {
    const child = paramNode.child(i);
    if (child?.type === 'rest_pattern') return true;
  }

  return false;
};

// ── Type annotation extraction ────────────────────────────────────────────────

/**
 * Extract the type string from a parameter's type annotation.
 * Returns undefined when no type annotation is present.
 */
const extractParamType = (paramNode: SyntaxNode): string | undefined => {
  const typeNode = paramNode.childForFieldName('type');
  if (typeNode) return extractSimpleTypeName(typeNode);

  // Fallback: find a type_annotation child
  for (let i = 0; i < paramNode.namedChildCount; i++) {
    const child = paramNode.namedChild(i);
    if (child?.type === 'type_annotation') {
      return extractSimpleTypeName(child);
    }
  }

  return undefined;
};

// ── Default value detection ───────────────────────────────────────────────────

/**
 * Returns true if the parameter has a default value (e.g. `method = 'GET'`).
 * TS/JS: optional_parameter with a 'value' field, or any parameter with an assignment.
 */
const hasDefaultValue = (paramNode: SyntaxNode): boolean => {
  // TS: optional_parameter may have a 'value' field for the default
  if (paramNode.childForFieldName('value') !== null) return true;

  // Some grammars emit assignment_pattern as a child
  for (let i = 0; i < paramNode.namedChildCount; i++) {
    const child = paramNode.namedChild(i);
    if (child?.type === 'assignment_pattern') return true;
  }

  return false;
};

// ── Parameter list discovery ──────────────────────────────────────────────────

/**
 * Find the formal parameter list node for a function/method/constructor AST node.
 * Returns null if no parameter list can be found.
 */
const findParameterListNode = (funcNode: SyntaxNode): SyntaxNode | null => {
  // Direct field lookup (most languages)
  const direct = funcNode.childForFieldName('parameters');
  if (direct && PARAM_LIST_NODE_TYPES.has(direct.type)) return direct;

  // If the node itself is a parameter list (e.g. C# primary constructors)
  if (PARAM_LIST_NODE_TYPES.has(funcNode.type)) return funcNode;

  // Search children shallowly (one level) for parameter list
  for (let i = 0; i < funcNode.childCount; i++) {
    const child = funcNode.child(i);
    if (child && PARAM_LIST_NODE_TYPES.has(child.type)) return child;
  }

  // Nested one level deeper (arrow functions, method wrappers, etc.)
  for (let i = 0; i < funcNode.childCount; i++) {
    const child = funcNode.child(i);
    if (!child) continue;
    for (let j = 0; j < child.childCount; j++) {
      const grandchild = child.child(j);
      if (grandchild && PARAM_LIST_NODE_TYPES.has(grandchild.type)) return grandchild;
    }
  }

  return null;
};

// ── Promoted property creation ────────────────────────────────────────────────

/**
 * Build a PromotedProperty record for a TypeScript constructor-promoted parameter.
 * e.g. `constructor(private db: Database)` creates a `db` Property on the class.
 *
 * @param paramNode - The constructor parameter AST node
 * @param paramName - Already-resolved parameter name
 * @param visibility - Already-resolved visibility modifier
 * @param filePath - Source file path
 * @param classId - generateId of the enclosing class node
 * @param paramType - Resolved type string (may be undefined)
 */
const buildPromotedProperty = (
  paramNode: SyntaxNode,
  paramName: string,
  visibility: 'public' | 'protected' | 'private',
  filePath: string,
  classId: string,
  paramType: string | undefined,
): PromotedProperty => {
  return {
    filePath,
    id: generateId('Property', `${filePath}:${classId.split(':').pop()}:${paramName}`),
    classId,
    name: paramName,
    startLine: paramNode.startPosition.row + 1,
    endLine: paramNode.endPosition.row + 1,
    type: paramType,
    visibility,
    isReadonly: hasReadonlyModifier(paramNode),
  };
};

// ── Main extraction function ──────────────────────────────────────────────────

/**
 * Extract all Parameter nodes from a function/method/constructor AST node.
 *
 * For each parameter found in the formal_parameters / parameter_list child:
 * - Produces one ExtractedParameter with id, parentId, ordinal, type, flags.
 * - For TypeScript constructor-promoted parameters (with accessibility_modifier),
 *   also produces a PromotedProperty in the result.
 *
 * ID scheme: `generateId('Parameter', `${filePath}:${funcName}:${paramName}`)`.
 * If a parameter name cannot be resolved (destructuring, anonymous), that parameter
 * is skipped rather than producing a partial record — fail loudly in name extraction,
 * silently skip structurally unresolvable patterns (destructuring is intentional).
 *
 * @param funcNode - AST node of the function/method/constructor
 * @param parentId - generateId of the parent Function/Method/Constructor graph node
 * @param funcName - Name of the parent function (used for id scoping)
 * @param filePath - Absolute source file path
 * @param classId - generateId of the enclosing class, required for promoted properties
 *                  (pass null for free functions)
 */
export const extractParameters = (
  funcNode: SyntaxNode,
  parentId: string,
  funcName: string,
  filePath: string,
  classId: string | null,
): ParameterExtractionResult => {
  const parameters: ExtractedParameter[] = [];
  const promotedProperties: PromotedProperty[] = [];

  const paramListNode = findParameterListNode(funcNode);
  if (!paramListNode) {
    return { parameters, promotedProperties };
  }

  let ordinal = 0;

  for (let i = 0; i < paramListNode.namedChildCount; i++) {
    const paramNode = paramListNode.namedChild(i);
    if (!paramNode) continue;

    // Skip comments
    if (paramNode.type === 'comment') continue;

    // Skip `self` / `this` — not real parameters in the graph model
    const rawText = paramNode.text;
    if (
      rawText === 'self' ||
      rawText === '&self' ||
      rawText === '&mut self' ||
      paramNode.type === 'self_parameter'
    ) {
      continue;
    }

    const paramName = extractParamName(paramNode);
    if (!paramName) {
      // Destructuring parameters (object/array patterns) cannot be given a single name.
      // Increment ordinal so subsequent params still get the right ordinal value.
      ordinal++;
      continue;
    }

    const paramType = extractParamType(paramNode);
    const isRest = isRestParam(paramNode);
    const hasDefault = !isRest && hasDefaultValue(paramNode);

    // isOptional: TS `optional_parameter` node, OR has a default value (default implies optional)
    const isOptional =
      paramNode.type === 'optional_parameter' ||
      hasDefault;

    const visibility = extractVisibilityFromParam(paramNode);

    const paramId = generateId('Parameter', `${filePath}:${funcName}:${paramName}`);

    parameters.push({
      filePath,
      id: paramId,
      parentId,
      name: paramName,
      startLine: paramNode.startPosition.row + 1,
      endLine: paramNode.endPosition.row + 1,
      ordinal,
      type: paramType,
      isOptional,
      hasDefault,
      isRest,
      visibility,
    });

    // TypeScript constructor parameter promotion:
    // If the parameter has a visibility modifier AND we have a class context,
    // create a promoted Property node for the implicit class field.
    if (visibility !== undefined && classId !== null) {
      const promoted = buildPromotedProperty(
        paramNode,
        paramName,
        visibility,
        filePath,
        classId,
        paramType,
      );
      promotedProperties.push(promoted);
    }

    ordinal++;
  }

  return { parameters, promotedProperties };
};

// ── Convenience helper: extract from multiple function nodes ─────────────────

/**
 * Batch-extract parameters from an array of function descriptors.
 * Returns a flat list of all ExtractedParameter records plus all promoted properties.
 *
 * @param funcs - Array of { funcNode, parentId, funcName, classId } descriptors
 * @param filePath - Source file path (shared across all functions in the same file)
 */
export const extractParametersBatch = (
  funcs: Array<{
    funcNode: SyntaxNode;
    parentId: string;
    funcName: string;
    classId: string | null;
  }>,
  filePath: string,
): ParameterExtractionResult => {
  const allParameters: ExtractedParameter[] = [];
  const allPromotedProperties: PromotedProperty[] = [];

  for (const { funcNode, parentId, funcName, classId } of funcs) {
    const result = extractParameters(funcNode, parentId, funcName, filePath, classId);
    allParameters.push(...result.parameters);
    allPromotedProperties.push(...result.promotedProperties);
  }

  return {
    parameters: allParameters,
    promotedProperties: allPromotedProperties,
  };
};
