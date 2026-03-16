/**
 * Visibility & Accessor Extraction
 *
 * Pure helper functions to extract `visibility`, `isAccessor`, `isReadonly`,
 * `isStatic`, and `isAbstract` from tree-sitter AST nodes. Intended for use
 * inside the parse worker — all functions are safe for worker threads.
 *
 * Language coverage:
 *  - TypeScript / JavaScript: full (accessibility_modifier, private_property_identifier,
 *    get/set accessor keywords, readonly, static, abstract)
 *  - Java / C# / Kotlin / PHP / Swift / Rust: visibility + static + abstract where
 *    applicable to the language's type system
 *  - Python / Go / Ruby / C / C++: no formal visibility; functions return undefined
 *    (callers should omit the property rather than storing undefined)
 *
 * Confidence: 1.0 (AST-derived facts)
 */

import { SyntaxNode } from './utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

// ─── Shared result type ────────────────────────────────────────────────────

export interface VisibilityMetadata {
  /** 'public' | 'protected' | 'private' — omit for languages with no formal visibility */
  visibility?: 'public' | 'protected' | 'private';
  /** True for get/set accessor methods (TS/JS/C#/Swift). */
  isAccessor?: boolean;
  /** True for readonly/const fields (TS/C#/Kotlin/Swift). */
  isReadonly?: boolean;
  /** True for static members (all class-based languages). */
  isStatic?: boolean;
  /** True for abstract methods/classes (TS/Java/C#/Kotlin/PHP). */
  isAbstract?: boolean;
}

// ─── TypeScript / JavaScript ───────────────────────────────────────────────

/**
 * For a `method_definition` or `public_field_definition` node in TS/JS, walk its
 * direct children to collect modifier tokens and the optional `accessibility_modifier`.
 */
const extractTsJsVisibility = (node: SyntaxNode): VisibilityMetadata => {
  const result: VisibilityMetadata = {};

  // JS private fields: name node is `private_property_identifier` (e.g. `#ssn`)
  const nameNode = node.childForFieldName?.('name') ?? null;
  if (nameNode?.type === 'private_property_identifier') {
    result.visibility = 'private';
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const text = child.text ?? '';
    const type = child.type;

    // TypeScript accessibility modifier
    if (type === 'accessibility_modifier') {
      const val = text as 'public' | 'protected' | 'private';
      if (val === 'public' || val === 'protected' || val === 'private') {
        result.visibility = val;
      }
    }

    // get / set accessor keyword
    if (!child.isNamed && (text === 'get' || text === 'set')) {
      result.isAccessor = true;
    }

    // readonly modifier
    if (!child.isNamed && text === 'readonly') {
      result.isReadonly = true;
    }
    if (type === 'readonly_type') {
      result.isReadonly = true;
    }

    // static modifier
    if (!child.isNamed && text === 'static') {
      result.isStatic = true;
    }

    // abstract modifier
    if (!child.isNamed && text === 'abstract') {
      result.isAbstract = true;
    }
  }

  // Default visibility for TS class members with no explicit modifier: public
  // For JS (no formal visibility system), leave undefined unless #private detected above
  if (result.visibility === undefined && nameNode?.type !== 'private_property_identifier') {
    // Only apply TS default for node types that are class member declarations
    const isClassMemberNode = (
      node.type === 'method_definition' ||
      node.type === 'public_field_definition' ||
      node.type === 'abstract_method_signature' ||
      node.type === 'method_signature'
    );
    if (isClassMemberNode) {
      result.visibility = 'public';
    }
  }

  return result;
};

// ─── Java ─────────────────────────────────────────────────────────────────

/**
 * For a Java method_declaration, constructor_declaration, field_declaration, etc.,
 * scan the `modifiers` child node for access modifiers.
 */
const extractJavaVisibility = (node: SyntaxNode): VisibilityMetadata => {
  const result: VisibilityMetadata = {};

  // Java modifiers are grouped in a `modifiers` child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === 'modifiers') {
      const text = child.text ?? '';
      if (text.includes('public')) result.visibility = 'public';
      else if (text.includes('protected')) result.visibility = 'protected';
      else if (text.includes('private')) result.visibility = 'private';

      if (text.includes('static')) result.isStatic = true;
      if (text.includes('abstract')) result.isAbstract = true;
      if (text.includes('final') && node.type === 'field_declaration') {
        result.isReadonly = true;
      }
    }
  }

  // Default: package-private (no formal keyword) — we map this to omit rather than store undefined
  return result;
};

// ─── C# ───────────────────────────────────────────────────────────────────

/** C# declaration node types that can carry modifiers. */
const CSHARP_MEMBER_DECL_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'property_declaration',
  'field_declaration',
  'event_declaration',
  'indexer_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'destructor_declaration',
]);

/**
 * For C# member declarations, walk direct children for `modifier` tokens.
 * Accessor detection uses the `accessor_list` child (get/set property).
 */
const extractCSharpVisibility = (node: SyntaxNode): VisibilityMetadata => {
  const result: VisibilityMetadata = {};

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const type = child.type;
    const text = child.text ?? '';

    if (type === 'modifier') {
      if (text === 'public') result.visibility = 'public';
      else if (text === 'protected') result.visibility = 'protected';
      else if (text === 'private') result.visibility = 'private';
      else if (text === 'static') result.isStatic = true;
      else if (text === 'abstract') result.isAbstract = true;
      else if (text === 'readonly') result.isReadonly = true;
    }

    // C# properties with get/set accessors
    if (type === 'accessor_list') {
      result.isAccessor = true;
    }
  }

  return result;
};

// ─── Kotlin ───────────────────────────────────────────────────────────────

/**
 * Kotlin: visibility_modifier is nested inside a `modifiers` sibling.
 * Walk the direct children of the declaration node.
 */
const extractKotlinVisibility = (node: SyntaxNode): VisibilityMetadata => {
  const result: VisibilityMetadata = {};

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === 'modifiers') {
      const text = child.text ?? '';

      // Visibility
      if (text.includes('public')) result.visibility = 'public';
      else if (text.includes('protected')) result.visibility = 'protected';
      else if (text.includes('private')) result.visibility = 'private';
      else if (text.includes('internal')) {
        // Kotlin `internal` has no direct JS/TS equivalent — treat as protected
        result.visibility = 'protected';
      }

      if (text.includes('override')) {/* not a visibility concern */}
      if (text.includes('abstract')) result.isAbstract = true;
      if (text.includes('open')) {/* open is the default for subclassing — not a visibility modifier */}
    }

    // companion object or static equivalent
    if (child.type === 'companion_object') {
      result.isStatic = true;
    }

    // val = immutable = readonly
    if (!child.isNamed && child.text === 'val') {
      result.isReadonly = true;
    }
  }

  // Kotlin default visibility: public
  if (!result.visibility) {
    result.visibility = 'public';
  }

  return result;
};

// ─── PHP ──────────────────────────────────────────────────────────────────

/**
 * PHP: visibility_modifier is a direct child of method_declaration /
 * property_declaration. `static` and `abstract` are sibling tokens.
 */
const extractPhpVisibility = (node: SyntaxNode): VisibilityMetadata => {
  const result: VisibilityMetadata = {};

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const type = child.type;
    const text = child.text ?? '';

    if (type === 'visibility_modifier') {
      if (text === 'public') result.visibility = 'public';
      else if (text === 'protected') result.visibility = 'protected';
      else if (text === 'private') result.visibility = 'private';
    }

    if (!child.isNamed && text === 'static') result.isStatic = true;
    if (!child.isNamed && text === 'abstract') result.isAbstract = true;
    if (!child.isNamed && text === 'readonly') result.isReadonly = true;
  }

  return result;
};

// ─── Swift ────────────────────────────────────────────────────────────────

/**
 * Swift: access modifiers appear in `modifiers` or directly as `visibility_modifier`
 * children. `static`/`class` keywords indicate static members.
 */
const extractSwiftVisibility = (node: SyntaxNode): VisibilityMetadata => {
  const result: VisibilityMetadata = {};

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const type = child.type;
    const text = child.text ?? '';

    if (type === 'modifiers' || type === 'visibility_modifier') {
      if (text.includes('public') || text.includes('open')) {
        result.visibility = 'public';
      } else if (text.includes('internal')) {
        // Swift internal = package-private; no equivalent, skip
      } else if (text.includes('fileprivate') || text.includes('private')) {
        result.visibility = 'private';
      }

      if (text.includes('static') || text.includes('class ')) {
        result.isStatic = true;
      }
      if (text.includes('override')) {/* not a modifier we track */}
    }

    // var vs let: let = immutable
    if (!child.isNamed && text === 'let') {
      result.isReadonly = true;
    }

    // get/set bodies: property with accessor_declaration children
    if (type === 'computed_property' || type === 'getter_specifier' || type === 'setter_specifier') {
      result.isAccessor = true;
    }
  }

  return result;
};

// ─── Rust ─────────────────────────────────────────────────────────────────

/**
 * Rust: pub / pub(crate) / pub(super) — no protected. Static is `static` keyword.
 * `const` items are readonly.
 */
const extractRustVisibility = (node: SyntaxNode): VisibilityMetadata => {
  const result: VisibilityMetadata = {};

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const type = child.type;
    const text = child.text ?? '';

    if (type === 'visibility_modifier' && text.startsWith('pub')) {
      result.visibility = 'public';
    }

    if (!child.isNamed && text === 'static') {
      result.isStatic = true;
    }

    if (!child.isNamed && text === 'const') {
      result.isReadonly = true;
    }
  }

  // No explicit pub = private in Rust
  if (!result.visibility) {
    result.visibility = 'private';
  }

  return result;
};

// ─── Dispatch table ───────────────────────────────────────────────────────

/** Languages with no formal visibility system — return empty metadata. */
const noVisibilityExtractor = (_node: SyntaxNode): VisibilityMetadata => ({});

type VisibilityExtractor = (node: SyntaxNode) => VisibilityMetadata;

const visibilityExtractors: Record<SupportedLanguages, VisibilityExtractor> = {
  [SupportedLanguages.TypeScript]: extractTsJsVisibility,
  [SupportedLanguages.JavaScript]: extractTsJsVisibility,
  [SupportedLanguages.Java]:       extractJavaVisibility,
  [SupportedLanguages.CSharp]:     extractCSharpVisibility,
  [SupportedLanguages.Kotlin]:     extractKotlinVisibility,
  [SupportedLanguages.PHP]:        extractPhpVisibility,
  [SupportedLanguages.Swift]:      extractSwiftVisibility,
  [SupportedLanguages.Rust]:       extractRustVisibility,
  // Languages without formal visibility: return empty object (callers omit fields)
  [SupportedLanguages.Python]:     noVisibilityExtractor,
  [SupportedLanguages.Go]:         noVisibilityExtractor,
  [SupportedLanguages.C]:          noVisibilityExtractor,
  [SupportedLanguages.CPlusPlus]:  noVisibilityExtractor,
  [SupportedLanguages.Ruby]:       noVisibilityExtractor,
} satisfies Record<SupportedLanguages, VisibilityExtractor>;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Extract visibility metadata from a class member AST node.
 *
 * @param node     - Tree-sitter AST node for the member declaration
 * @param language - Source language of the file
 * @returns        VisibilityMetadata with only the applicable fields set
 *
 * @example
 * ```typescript
 * const meta = extractVisibilityMetadata(methodNode, SupportedLanguages.TypeScript);
 * // { visibility: 'private', isStatic: true }
 * ```
 */
export const extractVisibilityMetadata = (
  node: SyntaxNode,
  language: SupportedLanguages,
): VisibilityMetadata => {
  const extractor = visibilityExtractors[language];
  if (!extractor) {
    throw new Error(`No visibility extractor registered for language: ${language}`);
  }
  return extractor(node);
};

/**
 * Narrow helper: extract only the `visibility` field.
 * Useful when callers only need the access modifier (e.g. for Property nodes).
 */
export const extractVisibility = (
  node: SyntaxNode,
  language: SupportedLanguages,
): 'public' | 'protected' | 'private' | undefined => {
  return extractVisibilityMetadata(node, language).visibility;
};

/**
 * Narrow helper: determine if an AST node represents a get/set accessor.
 * Returns true for TS/JS `get`/`set` keyword methods, C# property accessors,
 * Swift computed properties.
 */
export const extractIsAccessor = (
  node: SyntaxNode,
  language: SupportedLanguages,
): boolean => {
  return extractVisibilityMetadata(node, language).isAccessor === true;
};

/**
 * Narrow helper: determine if an AST node is marked readonly/immutable.
 * Covers TS `readonly`, C# `readonly`, Kotlin `val`, Swift `let`, Rust `const`.
 */
export const extractIsReadonly = (
  node: SyntaxNode,
  language: SupportedLanguages,
): boolean => {
  return extractVisibilityMetadata(node, language).isReadonly === true;
};

/**
 * Narrow helper: determine if an AST node is a static member.
 */
export const extractIsStatic = (
  node: SyntaxNode,
  language: SupportedLanguages,
): boolean => {
  return extractVisibilityMetadata(node, language).isStatic === true;
};

/**
 * Narrow helper: determine if an AST node is abstract.
 */
export const extractIsAbstract = (
  node: SyntaxNode,
  language: SupportedLanguages,
): boolean => {
  return extractVisibilityMetadata(node, language).isAbstract === true;
};
