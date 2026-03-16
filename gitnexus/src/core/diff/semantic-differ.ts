/**
 * semantic-differ.ts
 *
 * 3-pass AST-level semantic diff for a single file.
 *
 * Port of codebase-memory-mcp/internal/semdiff/differ.go — translated 1:1 to
 * TypeScript. The algorithm is language-agnostic; it operates on Definition
 * objects extracted from tree-sitter ASTs by GitNexus's existing extractors.
 *
 * Pass 1: Exact QualifiedName match → compareDefinitions field-by-field
 * Pass 2: Fuzzy rename detection (same label + 2-of-3 structural attributes)
 * Pass 3: Remaining unmatched → Added / Removed
 */

import Parser from 'tree-sitter';
import type { ChangeKind, Definition, FieldDelta, SymbolChange } from './types.js';
import { loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from '../ingestion/tree-sitter-queries.js';
import {
  getLanguageFromFilename,
  getDefinitionNodeFromCaptures,
  extractMethodSignature,
} from '../ingestion/utils.js';
import { isNodeExported } from '../ingestion/export-detection.js';
import { generateId } from '../../lib/utils.js';
import { gitShow } from '../../storage/git.js';

// ---------------------------------------------------------------------------
// Definition extraction from source
// ---------------------------------------------------------------------------

/**
 * Extract Definition objects from a source string using tree-sitter.
 * Mirrors the parse-worker logic but produces Definition rather than GraphNode.
 * Returns an empty array if the file cannot be parsed.
 */
export async function extractDefinitionsFromSource(
  filePath: string,
  source: string,
): Promise<Definition[]> {
  const language = getLanguageFromFilename(filePath);
  if (!language) return [];

  let parser: Parser;
  try {
    parser = await loadParser();
    await loadLanguage(language, filePath);
  } catch {
    return [];
  }

  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch (err) {
    console.warn(`semantic-differ: parse failed for ${filePath}: ${(err as Error).message}`);
    return [];
  }

  const queryString = LANGUAGE_QUERIES[language];
  if (!queryString) return [];

  let query: Parser.Query;
  let matches: Parser.QueryMatch[];
  try {
    const lang = parser.getLanguage();
    query = new Parser.Query(lang, queryString);
    matches = query.matches(tree.rootNode);
  } catch (err) {
    console.warn(`semantic-differ: query failed for ${filePath}: ${(err as Error).message}`);
    return [];
  }

  // Build a heritage map: className → parentNames[]
  // We need to collect all heritage captures first so we can attach baseClasses
  // to each Definition.
  const heritageMap = new Map<string, string[]>();
  for (const match of matches) {
    const captureMap: Record<string, any> = {};
    for (const c of match.captures) captureMap[c.name] = c.node;

    if (captureMap['heritage.class']) {
      const className: string = captureMap['heritage.class'].text;
      const parentName: string = (
        captureMap['heritage.extends'] ??
        captureMap['heritage.implements'] ??
        captureMap['heritage.trait']
      )?.text;
      if (parentName) {
        const existing = heritageMap.get(className) ?? [];
        existing.push(parentName);
        heritageMap.set(className, existing);
      }
    }
  }

  const definitions: Definition[] = [];

  for (const match of matches) {
    const captureMap: Record<string, any> = {};
    for (const c of match.captures) captureMap[c.name] = c.node;

    // Skip imports and call sites — only want definitions
    if (captureMap['import'] || captureMap['call'] || captureMap['heritage.class']) continue;

    const nameNode = captureMap['name'];
    if (!nameNode && !captureMap['definition.constructor']) continue;

    const nodeName: string = nameNode ? nameNode.text : 'init';

    // Determine label from capture keys (matches parse-worker.ts logic)
    let nodeLabel = 'CodeElement';
    if (captureMap['definition.function']) nodeLabel = 'Function';
    else if (captureMap['definition.class']) nodeLabel = 'Class';
    else if (captureMap['definition.interface']) nodeLabel = 'Interface';
    else if (captureMap['definition.method']) nodeLabel = 'Method';
    else if (captureMap['definition.struct']) nodeLabel = 'Struct';
    else if (captureMap['definition.enum']) nodeLabel = 'Enum';
    else if (captureMap['definition.namespace']) nodeLabel = 'Namespace';
    else if (captureMap['definition.module']) nodeLabel = 'Module';
    else if (captureMap['definition.trait']) nodeLabel = 'Trait';
    else if (captureMap['definition.impl']) nodeLabel = 'Impl';
    else if (captureMap['definition.type']) nodeLabel = 'TypeAlias';
    else if (captureMap['definition.const']) nodeLabel = 'Const';
    else if (captureMap['definition.static']) nodeLabel = 'Static';
    else if (captureMap['definition.typedef']) nodeLabel = 'Typedef';
    else if (captureMap['definition.macro']) nodeLabel = 'Macro';
    else if (captureMap['definition.union']) nodeLabel = 'Union';
    else if (captureMap['definition.property']) nodeLabel = 'Property';
    else if (captureMap['definition.record']) nodeLabel = 'Record';
    else if (captureMap['definition.delegate']) nodeLabel = 'Delegate';
    else if (captureMap['definition.annotation']) nodeLabel = 'Annotation';
    else if (captureMap['definition.constructor']) nodeLabel = 'Constructor';
    else if (captureMap['definition.template']) nodeLabel = 'Template';

    const definitionNode = getDefinitionNodeFromCaptures(captureMap);

    const startLine = definitionNode
      ? definitionNode.startPosition.row
      : (nameNode ? nameNode.startPosition.row : 0);
    const endLine = definitionNode
      ? definitionNode.endPosition.row
      : startLine;

    const isExported = isNodeExported(
      nameNode ?? definitionNode,
      nodeName,
      language,
    );

    // Extract param types and return type using extractMethodSignature
    let paramTypes: string[] = [];
    let returnType = '';
    let signature = '';

    if (
      nodeLabel === 'Function' ||
      nodeLabel === 'Method' ||
      nodeLabel === 'Constructor'
    ) {
      const sig = extractMethodSignature(definitionNode);
      returnType = sig.returnType ?? '';

      // Extract individual param type strings from the parameter list node
      paramTypes = extractParamTypes(definitionNode);

      // Build a signature string: "name(paramTypes): returnType"
      signature = buildSignatureString(nodeName, paramTypes, returnType, definitionNode);
    }

    // Extract decorators: look for decorator nodes that are siblings/parents
    const decorators = extractDecorators(definitionNode, nameNode);

    // Base classes from heritage map
    const baseClasses = heritageMap.get(nodeName) ?? [];

    const qualifiedName = buildQualifiedName(nodeLabel, filePath, nodeName, definitionNode);

    definitions.push({
      qualifiedName,
      name: nodeName,
      label: nodeLabel,
      filePath,
      startLine,
      endLine,
      signature,
      paramTypes,
      returnType,
      isExported,
      decorators,
      baseClasses,
      lines: endLine - startLine + 1,
    });
  }

  return definitions;
}

/**
 * Extract individual param type strings from a function/method AST node.
 * Returns an array of type strings (empty string for untyped params).
 */
function extractParamTypes(defNode: any): string[] {
  if (!defNode) return [];

  const paramListTypes = new Set([
    'formal_parameters', 'parameters', 'parameter_list',
    'function_parameters', 'method_parameters', 'function_value_parameters',
  ]);

  // Find param list
  let paramList: any = defNode.childForFieldName?.('parameters');
  if (!paramList) {
    for (const child of defNode.children ?? []) {
      if (paramListTypes.has(child.type)) { paramList = child; break; }
    }
  }
  if (!paramList) return [];

  const types: string[] = [];
  for (const param of paramList.namedChildren ?? []) {
    if (param.type === 'comment') continue;
    // Skip self/this parameters
    if (
      param.text === 'self' || param.text === '&self' || param.text === '&mut self' ||
      param.type === 'self_parameter'
    ) continue;

    // Try to extract a type annotation child
    const typeAnnotation =
      param.childForFieldName?.('type') ??
      param.children?.find((c: any) => c.type === 'type_annotation' || c.type === 'type_identifier' || c.type === 'predefined_type');

    if (typeAnnotation) {
      // For type_annotation nodes (: Type), get the inner type
      if (typeAnnotation.type === 'type_annotation') {
        const inner = typeAnnotation.children?.find((c: any) => c.isNamed);
        types.push(inner?.text ?? typeAnnotation.text);
      } else {
        types.push(typeAnnotation.text);
      }
    } else {
      // Untyped param — use empty string to preserve count
      types.push('');
    }
  }

  return types;
}

/**
 * Build a human-readable signature string for comparison.
 * Format: "name(type1, type2): returnType"
 */
function buildSignatureString(
  name: string,
  paramTypes: string[],
  returnType: string,
  defNode: any,
): string {
  // Use full text of param list if available for exact comparison
  let paramListTypes = new Set([
    'formal_parameters', 'parameters', 'parameter_list',
    'function_parameters', 'method_parameters', 'function_value_parameters',
  ]);

  let paramText: string | null = null;
  if (defNode) {
    let paramList: any = defNode.childForFieldName?.('parameters');
    if (!paramList) {
      for (const child of defNode.children ?? []) {
        if (paramListTypes.has(child.type)) { paramList = child; break; }
      }
    }
    if (paramList) paramText = paramList.text;
  }

  const params = paramText ?? `(${paramTypes.join(', ')})`;
  return returnType
    ? `${name}${params}: ${returnType}`
    : `${name}${params}`;
}

/**
 * Extract decorator names from the AST surrounding a definition node.
 * Works for TypeScript/Python decorators.
 */
function extractDecorators(defNode: any, nameNode: any): string[] {
  const decorators: string[] = [];
  const node = defNode ?? nameNode;
  if (!node) return decorators;

  // Walk siblings before the definition node looking for decorator_statement / decorator
  const parent = node.parent;
  if (!parent) return decorators;

  let idx = -1;
  for (let i = 0; i < parent.childCount; i++) {
    if (parent.child(i) === node) { idx = i; break; }
  }

  if (idx === -1) return decorators;

  for (let i = idx - 1; i >= 0; i--) {
    const sibling = parent.child(i);
    if (!sibling) break;
    if (sibling.type === 'decorator' || sibling.type === 'decorator_statement') {
      // Extract the decorator name (e.g., @Injectable → 'Injectable')
      const nameChild =
        sibling.children?.find((c: any) => c.type === 'identifier' || c.type === 'call_expression') ??
        sibling.firstNamedChild;
      if (nameChild) {
        // For call_expression decorators like @Injectable(), get the function name
        const funcName = nameChild.childForFieldName?.('function') ?? nameChild;
        decorators.unshift(funcName.text.replace(/^@/, ''));
      } else {
        decorators.unshift(sibling.text.replace(/^@/, ''));
      }
    } else {
      // Stop at first non-decorator
      break;
    }
  }

  return decorators;
}

/**
 * Build a stable qualified name for a definition.
 * Format: "filePath::label::name" — matches how the rest of GitNexus generates IDs.
 */
function buildQualifiedName(
  label: string,
  filePath: string,
  name: string,
  _defNode: any,
): string {
  // Use the same generateId scheme as the pipeline so QNs are consistent
  return generateId(label, `${filePath}:${name}`);
}

// ---------------------------------------------------------------------------
// Public diff API
// ---------------------------------------------------------------------------

/**
 * Diff two file versions semantically.
 *
 * @param repoPath  - Absolute path to the git repository
 * @param filePath  - Repo-relative file path (e.g. 'src/foo.ts')
 * @param fileStatus - One of 'A' (added), 'D' (deleted), 'M' (modified), 'R' (renamed)
 * @param ref       - Git ref for the old version (default: 'HEAD')
 * @returns Array of SymbolChange objects describing all semantic changes
 */
export async function diffFile(
  repoPath: string,
  filePath: string,
  fileStatus: 'A' | 'D' | 'M' | 'R',
  ref = 'HEAD',
): Promise<SymbolChange[]> {
  let oldSource = '';
  let newSource = '';

  if (fileStatus !== 'A') {
    oldSource = gitShow(repoPath, ref, filePath) ?? '';
  }

  if (fileStatus !== 'D') {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const absPath = path.resolve(repoPath, filePath);
    try {
      newSource = await fs.readFile(absPath, 'utf8');
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw new Error(`semantic-differ: cannot read ${absPath}: ${err?.message}`, { cause: err });
      newSource = '';
    }
  }

  const oldDefs = oldSource ? await extractDefinitionsFromSource(filePath, oldSource) : [];
  const newDefs = newSource ? await extractDefinitionsFromSource(filePath, newSource) : [];

  return diff(oldDefs, newDefs, filePath, fileStatus);
}

/**
 * Core diff algorithm — operates on already-extracted Definition arrays.
 * Called directly by diffFile; also exported for testing.
 */
export function diff(
  oldDefs: Definition[],
  newDefs: Definition[],
  filePath: string,
  fileStatus: string,
): SymbolChange[] {
  const oldFiltered = filterModules(oldDefs);
  const newFiltered = filterModules(newDefs);

  // Fast paths for added / deleted files
  if (fileStatus === 'A') return addedAll(newFiltered, filePath);
  if (fileStatus === 'D') return removedAll(oldFiltered, filePath);

  // Build QN lookup maps
  const oldByQN = new Map<string, Definition>(oldFiltered.map(d => [d.qualifiedName, d]));
  const newByQN = new Map<string, Definition>(newFiltered.map(d => [d.qualifiedName, d]));

  const changes: SymbolChange[] = [];

  // Pass 1: Exact QualifiedName match
  const matchedOld = new Set<string>();
  const matchedNew = new Set<string>();

  for (const [qn, oldDef] of oldByQN) {
    const newDef = newByQN.get(qn);
    if (newDef) {
      matchedOld.add(qn);
      matchedNew.add(qn);
      const change = compareDefinitions(oldDef, newDef, filePath);
      if (change) changes.push(change);
    }
  }

  // Collect unmatched
  const unmatchedOld = oldFiltered.filter(d => !matchedOld.has(d.qualifiedName));
  const unmatchedNew = newFiltered.filter(d => !matchedNew.has(d.qualifiedName));

  // Pass 2: Fuzzy rename detection — group by label to reduce search space
  const unmatchedOldByLabel = groupByLabel(unmatchedOld);
  const unmatchedNewByLabel = groupByLabel(unmatchedNew);

  const renamedOld = new Set<string>();
  const renamedNew = new Set<string>();

  for (const [label, oldGroup] of unmatchedOldByLabel) {
    const newGroup = unmatchedNewByLabel.get(label);
    if (!newGroup) continue;

    for (const od of oldGroup) {
      if (renamedOld.has(od.qualifiedName)) continue;

      const candidates = newGroup.filter(
        nd => !renamedNew.has(nd.qualifiedName) && isFuzzyMatch(od, nd),
      );

      // Deliberately conservative: only accept single-candidate renames
      if (candidates.length === 1) {
        const nd = candidates[0];
        renamedOld.add(od.qualifiedName);
        renamedNew.add(nd.qualifiedName);
        changes.push(buildRenameChange(od, nd, filePath));
      }
    }
  }

  // Pass 3: Remaining unmatched → Removed / Added
  for (const d of unmatchedOld) {
    if (!renamedOld.has(d.qualifiedName)) {
      changes.push(removedChange(d, filePath));
    }
  }
  for (const d of unmatchedNew) {
    if (!renamedNew.has(d.qualifiedName)) {
      changes.push(addedChange(d, filePath));
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Definition comparison
// ---------------------------------------------------------------------------

/**
 * Compare a matched old/new definition pair and return a SymbolChange if different.
 * Returns null when the definitions are structurally identical (no change to report).
 */
export function compareDefinitions(
  od: Definition,
  nd: Definition,
  filePath: string,
): SymbolChange | null {
  const deltas = computeDeltas(od, nd);

  if (deltas.length === 0) {
    return null;
  }

  const kind = classifyKind(deltas);

  return {
    kind,
    label: nd.label,
    name: nd.name,
    qualifiedName: nd.qualifiedName,
    filePath,
    deltas,
    isBreaking: false, // populated by classifyBreaking
  };
}

/**
 * Compute field-level deltas between two definitions.
 * Ports computeDeltas from differ.go exactly.
 */
export function computeDeltas(od: Definition, nd: Definition): FieldDelta[] {
  const deltas: FieldDelta[] = [];

  if (od.signature !== nd.signature) {
    deltas.push({ field: 'signature', old: od.signature, new: nd.signature });
  }

  const oldParams = od.paramTypes.join(', ');
  const newParams = nd.paramTypes.join(', ');
  if (oldParams !== newParams) {
    deltas.push({ field: 'param_types', old: oldParams, new: newParams });
  }

  if (od.returnType !== nd.returnType) {
    deltas.push({ field: 'return_type', old: od.returnType, new: nd.returnType });
  }

  if (od.isExported !== nd.isExported) {
    deltas.push({
      field: 'is_exported',
      old: od.isExported ? 'true' : 'false',
      new: nd.isExported ? 'true' : 'false',
    });
  }

  if (od.lines !== nd.lines) {
    deltas.push({ field: 'lines', old: String(od.lines), new: String(nd.lines) });
  }

  const oldDecorators = sortedJoin(od.decorators);
  const newDecorators = sortedJoin(nd.decorators);
  if (oldDecorators !== newDecorators) {
    deltas.push({ field: 'decorators', old: oldDecorators, new: newDecorators });
  }

  const oldBaseClasses = sortedJoin(od.baseClasses);
  const newBaseClasses = sortedJoin(nd.baseClasses);
  if (oldBaseClasses !== newBaseClasses) {
    deltas.push({ field: 'base_classes', old: oldBaseClasses, new: newBaseClasses });
  }

  return deltas;
}

/**
 * Classify the ChangeKind from a set of deltas.
 * Priority: SignatureChanged > VisibilityChanged > BodyChanged
 */
export function classifyKind(deltas: FieldDelta[]): ChangeKind {
  let hasVisibility = false;
  for (const d of deltas) {
    if (d.field === 'signature' || d.field === 'param_types' || d.field === 'return_type') {
      return 'SignatureChanged';
    }
    if (d.field === 'is_exported') {
      hasVisibility = true;
    }
  }
  if (hasVisibility) return 'VisibilityChanged';
  return 'BodyChanged';
}

/**
 * Fuzzy rename heuristic — at least 2 of 3 structural attributes must match:
 * - Same param count
 * - Same return type
 * - Similar line count (within ±50%)
 */
export function isFuzzyMatch(od: Definition, nd: Definition): boolean {
  let score = 0;

  if (od.paramTypes.length === nd.paramTypes.length) score++;
  if (od.returnType === nd.returnType) score++;

  if (od.lines > 0 && nd.lines > 0) {
    const ratio = nd.lines / od.lines;
    if (ratio >= 0.5 && ratio <= 2.0) score++;
  } else if (od.lines === nd.lines) {
    // Both zero
    score++;
  }

  return score >= 2;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterModules(defs: Definition[]): Definition[] {
  return defs.filter(d => d.label !== 'Module');
}

function addedAll(defs: Definition[], filePath: string): SymbolChange[] {
  return defs.map(d => addedChange(d, filePath));
}

function removedAll(defs: Definition[], filePath: string): SymbolChange[] {
  return defs.map(d => removedChange(d, filePath));
}

function addedChange(d: Definition, filePath: string): SymbolChange {
  return {
    kind: 'Added',
    label: d.label,
    name: d.name,
    qualifiedName: d.qualifiedName,
    filePath,
    deltas: [],
    isBreaking: false,
  };
}

function removedChange(d: Definition, filePath: string): SymbolChange {
  return {
    kind: 'Removed',
    label: d.label,
    name: d.name,
    qualifiedName: d.qualifiedName,
    filePath,
    deltas: [],
    isBreaking: false,
  };
}

function buildRenameChange(od: Definition, nd: Definition, filePath: string): SymbolChange {
  const deltas = computeDeltas(od, nd);
  return {
    kind: 'Renamed',
    label: nd.label,
    name: nd.name,
    qualifiedName: nd.qualifiedName,
    oldQualifiedName: od.qualifiedName,
    filePath,
    deltas,
    isBreaking: false,
  };
}

function groupByLabel(defs: Definition[]): Map<string, Definition[]> {
  const m = new Map<string, Definition[]>();
  for (const d of defs) {
    const arr = m.get(d.label) ?? [];
    arr.push(d);
    m.set(d.label, arr);
  }
  return m;
}

function sortedJoin(ss: string[]): string {
  if (ss.length === 0) return '';
  return [...ss].sort().join(', ');
}
