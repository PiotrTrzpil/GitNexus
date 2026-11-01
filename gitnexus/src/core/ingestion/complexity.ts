/**
 * Per-callable cyclomatic complexity and SLOC, computed from the tree-sitter
 * node the parse worker already holds for each Function/Method definition.
 *
 * `complexity` is classic McCabe: 1 + the number of decision points inside the
 * callable. Nested callables (closures, lambdas, inner functions) are opaque
 * for complexity, so each symbol is scored on its own body. `sloc` counts the
 * distinct source rows that carry code (comments and blank lines excluded);
 * nested callables count toward their parent's SLOC because their text is part
 * of it.
 *
 * Languages without an entry in {@link RULES} get `undefined` rather than a
 * guess. Adding one is a node-type table plus a test snippet.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import type { SyntaxNode } from './utils/ast-helpers.js';

export interface CallableMetrics {
  /** McCabe cyclomatic complexity (>= 1). */
  readonly complexity: number;
  /** Source lines of code: rows holding at least one non-comment token. */
  readonly sloc: number;
}

interface LanguageRules {
  /** Node types that each add one decision point. */
  readonly branches: ReadonlySet<string>;
  /** `binary_expression`-style node types whose operator may be short-circuit. */
  readonly binaryTypes: ReadonlySet<string>;
  /** Operators that add a decision point for {@link binaryTypes}. */
  readonly shortCircuitOperators: ReadonlySet<string>;
  /** Node types that start a callable (and so bound the walk). */
  readonly callables: ReadonlySet<string>;
  /** Node types that must not be searched for the callable (class bodies). */
  readonly containers: ReadonlySet<string>;
}

const set = (...items: string[]): ReadonlySet<string> => new Set(items);
const SHORT_CIRCUIT = set('&&', '||', '??');

const TS_JS: LanguageRules = {
  branches: set(
    'if_statement',
    'for_statement',
    'for_in_statement', // also for...of
    'while_statement',
    'do_statement',
    'switch_case',
    'catch_clause',
    'ternary_expression',
  ),
  binaryTypes: set('binary_expression'),
  shortCircuitOperators: SHORT_CIRCUIT,
  callables: set(
    'function_declaration',
    'function_expression',
    'function',
    'arrow_function',
    'generator_function_declaration',
    'generator_function',
    'method_definition',
  ),
  containers: set('class_body'),
};

const PYTHON: LanguageRules = {
  branches: set(
    'if_statement',
    'elif_clause',
    'for_statement',
    'while_statement',
    'except_clause',
    'except_group_clause',
    'conditional_expression',
    'boolean_operator',
    'case_clause',
    'for_in_clause', // comprehension loop
    'if_clause', // comprehension filter
  ),
  binaryTypes: set(),
  shortCircuitOperators: set(),
  callables: set('function_definition', 'lambda'),
  containers: set('class_definition'),
};

const JAVA: LanguageRules = {
  branches: set(
    'if_statement',
    'for_statement',
    'enhanced_for_statement',
    'while_statement',
    'do_statement',
    'switch_label', // `case X`
    'catch_clause',
    'ternary_expression',
  ),
  binaryTypes: set('binary_expression'),
  shortCircuitOperators: set('&&', '||'),
  callables: set('method_declaration', 'constructor_declaration', 'lambda_expression'),
  containers: set('class_body'),
};

const GO: LanguageRules = {
  branches: set(
    'if_statement',
    'for_statement',
    'expression_case',
    'type_case',
    'communication_case',
  ),
  binaryTypes: set('binary_expression'),
  shortCircuitOperators: set('&&', '||'),
  callables: set('function_declaration', 'method_declaration', 'func_literal'),
  containers: set(),
};

const RUST: LanguageRules = {
  branches: set(
    'if_expression',
    'while_expression',
    'for_expression',
    'loop_expression',
    'match_arm',
  ),
  binaryTypes: set('binary_expression'),
  shortCircuitOperators: set('&&', '||'),
  callables: set('function_item', 'closure_expression'),
  containers: set('declaration_list'),
};

const C_FAMILY: LanguageRules = {
  branches: set(
    'if_statement',
    'for_statement',
    'for_range_loop',
    'while_statement',
    'do_statement',
    'case_statement',
    'catch_clause',
    'conditional_expression',
  ),
  binaryTypes: set('binary_expression'),
  shortCircuitOperators: set('&&', '||'),
  callables: set('function_definition', 'lambda_expression'),
  containers: set('field_declaration_list'),
};

const CSHARP: LanguageRules = {
  branches: set(
    'if_statement',
    'for_statement',
    'foreach_statement',
    'while_statement',
    'do_statement',
    'switch_section',
    'catch_clause',
    'conditional_expression',
  ),
  binaryTypes: set('binary_expression'),
  shortCircuitOperators: SHORT_CIRCUIT,
  callables: set(
    'method_declaration',
    'constructor_declaration',
    'local_function_statement',
    'lambda_expression',
    'anonymous_method_expression',
  ),
  containers: set('declaration_list'),
};

const RULES: Partial<Record<SupportedLanguages, LanguageRules>> = {
  [SupportedLanguages.TypeScript]: TS_JS,
  [SupportedLanguages.JavaScript]: TS_JS,
  [SupportedLanguages.Python]: PYTHON,
  [SupportedLanguages.Java]: JAVA,
  [SupportedLanguages.Go]: GO,
  [SupportedLanguages.Rust]: RUST,
  [SupportedLanguages.C]: C_FAMILY,
  [SupportedLanguages.CPlusPlus]: C_FAMILY,
  [SupportedLanguages.CSharp]: CSHARP,
};

const COMMENT_TYPE = /comment/;
/** Definition nodes wrap their callable at most this deep (export > decl > declarator > fn). */
const MAX_WRAPPER_DEPTH = 5;

/** Find the callable node a definition capture refers to (the node itself or a wrapped one). */
const findCallable = (root: SyntaxNode, rules: LanguageRules): SyntaxNode | undefined => {
  let level: SyntaxNode[] = [root];
  for (let depth = 0; depth <= MAX_WRAPPER_DEPTH && level.length > 0; depth++) {
    const next: SyntaxNode[] = [];
    for (const node of level) {
      if (rules.callables.has(node.type)) return node;
      if (rules.containers.has(node.type)) continue;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) next.push(child);
      }
    }
    level = next;
  }
  return undefined;
};

/**
 * Metrics for the callable defined at `definitionNode`, or `undefined` when the
 * language has no rules or the node holds no callable body (abstract/declared
 * only).
 */
export const computeCallableMetrics = (
  definitionNode: SyntaxNode,
  language: SupportedLanguages,
): CallableMetrics | undefined => {
  const rules = RULES[language];
  if (!rules) return undefined;
  const callable = findCallable(definitionNode, rules);
  if (!callable) return undefined;

  let branches = 0;
  const codeRows = new Set<number>();

  const walk = (node: SyntaxNode, nested: boolean): void => {
    if (COMMENT_TYPE.test(node.type)) return;
    const isNestedCallable = node !== callable && rules.callables.has(node.type);
    const nestedHere = nested || isNestedCallable;
    if (!nestedHere && node !== callable) {
      if (rules.branches.has(node.type)) {
        // `default:` labels (Java switch_label, C case_statement, C# switch_section)
        // are the fallthrough path, not a decision point.
        if (node.child(0)?.type !== 'default') branches++;
      } else if (rules.binaryTypes.has(node.type)) {
        const op = node.childForFieldName('operator')?.text;
        if (op !== undefined && rules.shortCircuitOperators.has(op)) branches++;
      }
    }
    if (node.childCount === 0) {
      for (let row = node.startPosition.row; row <= node.endPosition.row; row++) codeRows.add(row);
      return;
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, nestedHere);
    }
  };
  walk(callable, false);

  return { complexity: branches + 1, sloc: codeRows.size };
};
