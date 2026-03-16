import { SupportedLanguages } from '../../config/supported-languages.js';
import type { SyntaxNode } from './utils.js';

// ============================================================================
// Language-specific branching node type sets
// ============================================================================

/**
 * TypeScript and JavaScript branching AST node types that contribute to
 * cyclomatic complexity.
 *
 * Based on the definition in the semantic-depth design:
 * if_statement, for_statement, for_in_statement, while_statement,
 * do_statement, switch_case, catch_clause, ternary_expression,
 * logical_expression (&&, ||), optional_chain_expression.
 *
 * Note: for/while loop bodies are NOT counted — loops add one branch node
 * (the loop itself, via for_statement / while_statement / do_statement)
 * to differentiate "always executes once" vs "may execute multiple times"
 * from truly branching constructs. We count the loop-entry branch (the
 * condition check at loop head), which matches the classical cyclomatic
 * complexity definition.
 */
const TYPESCRIPT_BRANCHING_TYPES = new Set([
  'if_statement',
  'else_clause',           // explicit else branch
  'for_statement',
  'for_in_statement',      // for...in
  'for_of_statement',      // for...of
  'while_statement',
  'do_statement',
  'switch_case',           // each case label
  'catch_clause',
  'ternary_expression',
  'logical_expression',    // && / || / ??
  'optional_chain',        // foo?.bar()
]);

const JAVASCRIPT_BRANCHING_TYPES = TYPESCRIPT_BRANCHING_TYPES; // identical grammar

/**
 * Python branching AST node types.
 */
const PYTHON_BRANCHING_TYPES = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'for_statement',
  'while_statement',
  'try_statement',
  'except_clause',
  'conditional_expression',  // ternary: a if cond else b
  'boolean_operator',        // and / or
  'with_statement',          // context manager (minor branch)
]);

/**
 * Java branching AST node types.
 */
const JAVA_BRANCHING_TYPES = new Set([
  'if_statement',
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
  'switch_expression',
  'switch_rule',             // Java 14+ arrow-case
  'switch_block_statement_group',
  'catch_clause',
  'ternary_expression',
  'binary_expression',       // &&, ||
]);

/**
 * C branching AST node types.
 */
const C_BRANCHING_TYPES = new Set([
  'if_statement',
  'for_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'case_statement',
  'conditional_expression',  // ternary
  'binary_expression',       // &&, ||
]);

/**
 * C++ branching AST node types (superset of C).
 */
const CPP_BRANCHING_TYPES = new Set([
  ...C_BRANCHING_TYPES,
  'try_statement',
  'catch_clause',
  'range_based_for_statement',
  'throw_expression',        // not a branch but raises complexity
]);

/**
 * C# branching AST node types.
 */
const CSHARP_BRANCHING_TYPES = new Set([
  'if_statement',
  'for_statement',
  'for_each_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'switch_section',
  'switch_expression_arm',   // C# 8 pattern matching
  'catch_clause',
  'conditional_expression',  // ternary
  'binary_expression',       // && / ||
  'null_coalescing_expression', // ??
  'conditional_access_expression', // ?.
]);

/**
 * Go branching AST node types.
 */
const GO_BRANCHING_TYPES = new Set([
  'if_statement',
  'for_statement',
  'range_clause',            // for range loop
  'type_switch_statement',
  'expression_switch_statement',
  'expression_case',
  'type_case',
  'communication_case',      // select { case ... }
  'select_statement',
]);

/**
 * Rust branching AST node types.
 */
const RUST_BRANCHING_TYPES = new Set([
  'if_expression',
  'if_let_expression',
  'while_expression',
  'while_let_expression',
  'loop_expression',
  'for_expression',
  'match_expression',
  'match_arm',
  'closure_expression',
  'try_expression',          // ? operator (minor branch)
]);

/**
 * Kotlin branching AST node types.
 */
const KOTLIN_BRANCHING_TYPES = new Set([
  'if_expression',
  'when_expression',
  'when_entry',
  'for_statement',
  'while_statement',
  'do_while_statement',
  'try_expression',
  'catch_block',
  'lambda_literal',
  'boolean_literal',         // not actually branching — excluded below
]);

/**
 * PHP branching AST node types.
 */
const PHP_BRANCHING_TYPES = new Set([
  'if_statement',
  'for_statement',
  'foreach_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'case_statement',
  'catch_clause',
  'conditional_expression',  // ternary
  'binary_expression',       // && / ||
  'null_coalescing_expression', // ??
  'null_coalescing_assignment_expression',
]);

/**
 * Ruby branching AST node types.
 */
const RUBY_BRANCHING_TYPES = new Set([
  'if',
  'unless',
  'elsif',
  'else',
  'case',
  'when',
  'for',
  'while',
  'until',
  'rescue',
  'ensure',
  'conditional',             // ternary
  'and',                     // and / or (low-precedence booleans)
  'or',
]);

/**
 * Swift branching AST node types.
 */
const SWIFT_BRANCHING_TYPES = new Set([
  'if_statement',
  'guard_statement',
  'for_in_statement',
  'while_statement',
  'repeat_while_statement',
  'switch_statement',
  'switch_case',
  'catch_clause',
  'ternary_expression',
  'boolean_literal',         // not actually branching — excluded below
  'nil_coalescing_expression', // ??
]);

/**
 * Map from SupportedLanguages to the corresponding branching type set.
 * Used by computeComplexity to dispatch to the right set per language.
 */
export const BRANCHING_TYPES_BY_LANGUAGE: Readonly<Record<SupportedLanguages, ReadonlySet<string>>> = {
  [SupportedLanguages.TypeScript]: TYPESCRIPT_BRANCHING_TYPES,
  [SupportedLanguages.JavaScript]: JAVASCRIPT_BRANCHING_TYPES,
  [SupportedLanguages.Python]: PYTHON_BRANCHING_TYPES,
  [SupportedLanguages.Java]: JAVA_BRANCHING_TYPES,
  [SupportedLanguages.C]: C_BRANCHING_TYPES,
  [SupportedLanguages.CPlusPlus]: CPP_BRANCHING_TYPES,
  [SupportedLanguages.CSharp]: CSHARP_BRANCHING_TYPES,
  [SupportedLanguages.Go]: GO_BRANCHING_TYPES,
  [SupportedLanguages.Rust]: RUST_BRANCHING_TYPES,
  [SupportedLanguages.Kotlin]: KOTLIN_BRANCHING_TYPES,
  [SupportedLanguages.PHP]: PHP_BRANCHING_TYPES,
  [SupportedLanguages.Ruby]: RUBY_BRANCHING_TYPES,
  [SupportedLanguages.Swift]: SWIFT_BRANCHING_TYPES,
};

// ============================================================================
// Complexity computation
// ============================================================================

/**
 * Count branching AST nodes within a function/method body node to compute
 * cyclomatic complexity.
 *
 * Convention: complexity = number of branching nodes found (0 for a straight-
 * line function with no branches). This matches codebase-memory-mcp's
 * `cbm_count_branching` convention — callers add 1 if they want the classic
 * McCabe complexity (base path count).
 *
 * The walk is **not recursive into nested function bodies** — inner functions,
 * arrow functions, class expressions, and lambdas are treated as opaque
 * boundaries so that each symbol gets its own independent complexity score.
 *
 * @param bodyNode  The body node of the function/method (e.g. `statement_block`
 *                  for TS/JS, `block` for Python). Passing the full function
 *                  declaration node also works — the walk simply traverses all
 *                  descendants.
 * @param language  The language of the file, used to select the correct
 *                  branching type set.
 * @returns Branching node count (integer >= 0).
 */
export const computeComplexity = (
  bodyNode: SyntaxNode,
  language: SupportedLanguages,
): number => {
  const branchingTypes = BRANCHING_TYPES_BY_LANGUAGE[language];
  if (!branchingTypes) {
    throw new Error(`computeComplexity: unsupported language "${language}"`);
  }

  /**
   * Nested function/method node types that should NOT be recursed into.
   * We stop descent at these boundaries so that each symbol's complexity
   * is self-contained.
   */
  const NESTED_FUNCTION_BOUNDARY_TYPES = new Set([
    // TS/JS
    'function_declaration',
    'function_expression',
    'arrow_function',
    'generator_function_declaration',
    'generator_function',
    'async_function_declaration',
    'async_function',
    // Python
    'function_definition',
    // Java / C#
    'method_declaration',
    'constructor_declaration',
    'local_function_statement',
    // C/C++
    'function_definition',
    // Go
    'func_literal',
    // Rust
    'function_item',
    'closure_expression',
    // Kotlin
    'lambda_literal',
    'anonymous_function',
    // PHP
    'anonymous_function',
    'arrow_function',
    // Ruby
    'method',
    'singleton_method',
    'block',
    'do_block',
    // Swift
    'closure_expression',
    // Generic
    'class_declaration',
    'class_definition',
    'interface_declaration',
  ]);

  let count = 0;

  /**
   * Depth-first walk of the AST subtree rooted at `node`.
   * Stops recursion at nested function boundaries.
   */
  const walk = (node: SyntaxNode, isRoot: boolean): void => {
    // Count this node if it's a branching construct (skip the root itself
    // since it's the function body, not a branch).
    if (!isRoot && branchingTypes.has(node.type)) {
      count++;
    }

    // Do not recurse into nested function/method/lambda bodies.
    // Exception: the root node itself IS the function body — we must recurse into it.
    if (!isRoot && NESTED_FUNCTION_BOUNDARY_TYPES.has(node.type)) {
      return;
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        walk(child, false);
      }
    }
  };

  walk(bodyNode, true);

  return count;
};

/**
 * Compute source lines of code (SLOC) for a node.
 *
 * Uses `endLine - startLine + 1` — the same cheap calculation already used
 * for node storage. Does not subtract blank/comment lines; callers that need
 * logical SLOC can post-process.
 *
 * @param node  Any AST node that exposes `startPosition.row` / `endPosition.row`.
 * @returns Integer >= 1.
 */
export const computeSloc = (node: SyntaxNode): number => {
  const startLine = node.startPosition.row + 1; // tree-sitter rows are 0-indexed
  const endLine = node.endPosition.row + 1;
  return Math.max(1, endLine - startLine + 1);
};
