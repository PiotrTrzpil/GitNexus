/**
 * Definitions from a source string.
 *
 * The graph only describes the working tree as it was last indexed. A semantic
 * diff needs the same file at two points in time (a git ref and the working
 * tree), so this re-parses a single source string with the language's
 * tree-sitter grammar and the same definition queries, label rules, export
 * checker and method extractor the ingestion pipeline uses. Nothing is written
 * to the graph.
 */

import Parser from 'tree-sitter';
import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import { LANGUAGE_QUERIES } from '../ingestion/tree-sitter-queries.js';
import { getProviderForFile } from '../ingestion/languages/index.js';
import {
  findEnclosingClassInfo,
  getDefinitionNodeFromCaptures,
  getLabelFromCaptures,
  type SyntaxNode,
} from '../ingestion/utils/ast-helpers.js';
import type { LanguageProvider } from '../ingestion/language-provider.js';
import type { MethodInfo } from '../ingestion/method-types.js';
import {
  createParserForLanguage,
  getLanguageGrammar,
  isLanguageAvailable,
} from '../tree-sitter/parser-loader.js';
import { parseSourceSafe } from '../tree-sitter/safe-parse.js';

export interface SourceDefinition {
  /** Identity inside one file: `Label:Owner.name` (`#n` suffix for duplicates). */
  key: string;
  name: string;
  /** Enclosing class/interface name, '' for top-level symbols. */
  owner: string;
  label: string;
  isExported: boolean;
  /** Contract text compared across versions (params + return type, class header, type body). */
  signature: string;
  /** Number of declared parameters for callables, 0 otherwise. */
  paramCount: number;
  /** Whitespace-collapsed full text of the definition. */
  text: string;
  startLine: number;
  endLine: number;
}

export type ExtractResult =
  { supported: true; definitions: SourceDefinition[] } | { supported: false; reason: string };

const CALLABLE_LABELS = new Set(['Function', 'Method', 'Constructor']);
/** Containers whose members are reported separately: only the header is the contract. */
const HEADER_LABELS = new Set(['Class', 'Interface', 'Struct', 'Trait', 'Namespace', 'Record']);
/** Labels whose whole text is the contract (a changed type body is a changed contract). */
const SHAPE_LABELS = new Set(['TypeAlias', 'Enum', 'Property', 'Typedef', 'Union', 'Delegate']);
const SKIPPED_LABELS = new Set(['Module', 'Impl', 'CodeElement', 'Template']);

/**
 * JS/TS export check by ancestry. The provider's `tsExportChecker` also treats
 * any node whose text starts with `export ` as exported, which includes the
 * `program` node of every file whose first line is an export, so it would mark
 * every symbol in such a file exported. A semantic diff cannot tolerate that:
 * it decides what is breaking.
 */
function isExportedByAncestry(node: SyntaxNode): boolean {
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
    if (cur.type === 'export_statement') return true;
  }
  return false;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const formatParams = (info: MethodInfo): string =>
  info.parameters
    .map(
      (p) =>
        `${p.isVariadic ? '...' : ''}${p.name}${p.isOptional ? '?' : ''}${p.type ? `: ${p.type}` : ''}`,
    )
    .join(', ');

/** Method metadata from the language's own method extractor, or null. */
function methodInfoFor(
  provider: LanguageProvider,
  defNode: SyntaxNode,
  name: string,
  filePath: string,
  language: NonNullable<ReturnType<typeof getLanguageFromFilename>>,
): MethodInfo | null {
  const extractor = provider.methodExtractor;
  if (!extractor) return null;
  const ctx = { filePath, language };
  const standalone = extractor.extractFromNode?.(defNode, ctx);
  if (standalone) return standalone;
  let owner: SyntaxNode | null = defNode.parent;
  while (owner && !extractor.isTypeDeclaration(owner)) owner = owner.parent;
  if (!owner) return null;
  const methods = extractor.extract(owner, ctx)?.methods ?? [];
  const line = defNode.startPosition.row + 1;
  return (
    methods.find(
      (m) => m.name === name && m.line === line && m.column === defNode.startPosition.column,
    ) ??
    methods.find((m) => m.name === name && m.line === line) ??
    null
  );
}

/** Parameter list and return type read straight off the AST, for languages/shapes with no method info. */
function astSignature(defNode: SyntaxNode): { text: string; paramCount: number } {
  const queue: SyntaxNode[] = [defNode];
  for (let depth = 0; queue.length > 0 && depth < 40; depth++) {
    const node = queue.shift()!;
    const params = node.childForFieldName('parameters');
    if (params) {
      const ret =
        node.childForFieldName('return_type') ??
        node.childForFieldName('returnType') ??
        node.childForFieldName('result');
      return {
        text: collapse(params.text + (ret ? ` ${ret.text}` : '')),
        paramCount: params.namedChildren.filter((c) => c.type !== 'comment').length,
      };
    }
    queue.push(...node.namedChildren);
  }
  return { text: '', paramCount: 0 };
}

function headerText(defNode: SyntaxNode): string {
  const body = defNode.childForFieldName('body');
  const end = body ? body.startIndex - defNode.startIndex : defNode.text.indexOf('\n');
  const raw = end > 0 ? defNode.text.slice(0, end) : defNode.text;
  return collapse(raw.replace(/[{:]\s*$/, ''));
}

/**
 * Extract the symbols defined in `source`. Never throws: an unknown language,
 * an unavailable grammar or an unparseable file yields `{ supported: false }`
 * so callers can degrade to "not analysed" instead of failing the whole run.
 */
export async function extractDefinitionsFromSource(
  filePath: string,
  source: string,
): Promise<ExtractResult> {
  const language = getLanguageFromFilename(filePath);
  if (!language) return { supported: false, reason: 'unknown language' };
  const provider = getProviderForFile(filePath);
  const queryText = LANGUAGE_QUERIES[language];
  if (!provider || !queryText) return { supported: false, reason: 'no definition queries' };
  if (!isLanguageAvailable(language, filePath)) {
    return { supported: false, reason: 'grammar unavailable' };
  }

  let matches: Parser.QueryMatch[];
  try {
    const parser = await createParserForLanguage(language, filePath);
    const tree = parseSourceSafe(parser, source, undefined, undefined, filePath);
    matches = new Parser.Query(getLanguageGrammar(language, filePath), queryText).matches(
      tree.rootNode,
    );
  } catch (err) {
    return { supported: false, reason: `parse failed: ${(err as Error).message}` };
  }

  const definitions: SourceDefinition[] = [];
  const seenStarts = new Set<string>();
  const keyCounts = new Map<string, number>();

  for (const match of matches) {
    const captureMap: Record<string, SyntaxNode> = {};
    for (const c of match.captures) captureMap[c.name] = c.node;

    const label = getLabelFromCaptures(captureMap, provider);
    if (!label || SKIPPED_LABELS.has(label)) continue;
    const defNode = getDefinitionNodeFromCaptures(captureMap);
    const nameNode = captureMap['name'];
    if (!defNode) continue;
    const name =
      nameNode?.text ??
      provider.methodExtractor?.extractFunctionName?.(defNode, filePath)?.funcName ??
      null;
    if (!name) continue;

    const owner = findEnclosingClassInfo(defNode, filePath)?.className ?? '';

    // Overlapping query patterns can capture one declaration twice, with
    // different definition nodes; the same label/owner/name on one line is that.
    const startKey = `${label}:${owner}.${name}:${defNode.startPosition.row}`;
    if (seenStarts.has(startKey)) continue;
    seenStarts.add(startKey);
    let isExported = false;
    try {
      isExported =
        language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript
          ? isExportedByAncestry(nameNode ?? defNode)
          : provider.exportChecker(nameNode ?? defNode, name);
    } catch {
      isExported = false;
    }

    let signature = '';
    let paramCount = 0;
    if (CALLABLE_LABELS.has(label)) {
      const info = methodInfoFor(provider, defNode, name, filePath, language);
      if (info) {
        signature = `(${formatParams(info)})${info.returnType ? `: ${info.returnType}` : ''}`;
        paramCount = info.parameters.length;
        if (info.visibility === 'private' || info.visibility === 'protected') isExported = false;
      } else {
        const ast = astSignature(defNode);
        signature = ast.text;
        paramCount = ast.paramCount;
      }
    } else if (HEADER_LABELS.has(label)) {
      signature = headerText(defNode);
    } else if (SHAPE_LABELS.has(label)) {
      signature = collapse(defNode.text);
    }

    const baseKey = `${label}:${owner ? `${owner}.` : ''}${name}`;
    const seen = keyCounts.get(baseKey) ?? 0;
    keyCounts.set(baseKey, seen + 1);

    definitions.push({
      key: seen === 0 ? baseKey : `${baseKey}#${seen}`,
      name,
      owner,
      label,
      isExported,
      signature,
      paramCount,
      // Members of a container are diffed as symbols of their own, so a container's
      // "body" is just its header; otherwise every member edit would also flag the class.
      text: HEADER_LABELS.has(label) ? signature : collapse(defNode.text),
      startLine: defNode.startPosition.row + 1,
      endLine: defNode.endPosition.row + 1,
    });
  }

  return { supported: true, definitions };
}
