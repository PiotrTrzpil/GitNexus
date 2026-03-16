/**
 * MCP Tool Definitions
 * 
 * Defines the tools that GitNexus exposes to external AI agents.
 * All tools support an optional `repo` parameter for multi-repo setups.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      default?: any;
      items?: { type: string; enum?: string[] };
      enum?: string[];
    }>;
    required: string[];
  };
}

export const GITNEXUS_TOOLS: ToolDefinition[] = [
  {
    name: 'list_repos',
    description: `List all indexed repositories available to GitNexus.

Returns each repo's name, path, indexed date, last commit, and stats.

WHEN TO USE: First step when multiple repos are indexed, or to discover available repos.
AFTER THIS: READ gitnexus://repo/{name}/context for the repo you want to work with.

When multiple repos are indexed, you MUST specify the "repo" parameter
on other tools (query, context, impact, etc.) to target the correct one.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'query',
    description: `Query the code knowledge graph for execution flows related to a concept.
Returns processes (call chains) ranked by relevance, each with its symbols and file locations.

WHEN TO USE: Understanding how code works together. Use this when you need execution flows and relationships, not just file matches. Complements grep/IDE search.
AFTER THIS: Use context() on a specific symbol for 360-degree view (callers, callees, categorized refs).

Returns results grouped by process (execution flow):
- processes: ranked execution flows with relevance priority
- process_symbols: all symbols in those flows with file locations and module (functional area)
- definitions: standalone types/interfaces not in any process

Hybrid ranking: BM25 keyword + semantic vector search, ranked by Reciprocal Rank Fusion.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query' },
        task_context: { type: 'string', description: 'What you are working on (e.g., "adding OAuth support"). Helps ranking.' },
        goal: { type: 'string', description: 'What you want to find (e.g., "existing auth validation logic"). Helps ranking.' },
        limit: { type: 'number', description: 'Max processes to return (default: 5)', default: 5 },
        max_symbols: { type: 'number', description: 'Max symbols per process (default: 10)', default: 10 },
        include_content: { type: 'boolean', description: 'Include full symbol source code (default: false)', default: false },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cypher',
    description: `Execute Cypher query against the code knowledge graph.

WHEN TO USE: Complex structural queries that search/explore can't answer. READ gitnexus://repo/{name}/schema first for the full schema.
AFTER THIS: Use context() on result symbols for deeper context.

SCHEMA:
- Nodes: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process
- Multi-language nodes (use backticks): \`Struct\`, \`Enum\`, \`Trait\`, \`Impl\`, etc.
- All edges via single CodeRelation table with 'type' property
- Edge types: CONTAINS, DEFINES, CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, OVERRIDES, MEMBER_OF, STEP_IN_PROCESS
- Edge properties: type (STRING), confidence (DOUBLE), reason (STRING), step (INT32)

EXAMPLES:
• Find callers of a function:
  MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: "validateUser"}) RETURN a.name, a.filePath

• Find community members:
  MATCH (f)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community) WHERE c.heuristicLabel = "Auth" RETURN f.name

• Trace a process:
  MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE p.heuristicLabel = "UserLogin" RETURN s.name, r.step ORDER BY r.step

• Find all methods of a class:
  MATCH (c:Class {name: "UserService"})-[r:CodeRelation {type: 'HAS_METHOD'}]->(m:Method) RETURN m.name, m.parameterCount, m.returnType

• Find method overrides (MRO resolution):
  MATCH (winner:Method)-[r:CodeRelation {type: 'OVERRIDES'}]->(loser:Method) RETURN winner.name, winner.filePath, loser.filePath, r.reason

• Detect diamond inheritance:
  MATCH (d:Class)-[:CodeRelation {type: 'EXTENDS'}]->(b1), (d)-[:CodeRelation {type: 'EXTENDS'}]->(b2), (b1)-[:CodeRelation {type: 'EXTENDS'}]->(a), (b2)-[:CodeRelation {type: 'EXTENDS'}]->(a) WHERE b1 <> b2 RETURN d.name, b1.name, b2.name, a.name

OUTPUT: Returns { markdown, row_count } — results formatted as a Markdown table for easy reading.

TIPS:
- All relationships use single CodeRelation table — filter with {type: 'CALLS'} etc.
- Community = auto-detected functional area (Leiden algorithm)
- Process = execution flow trace from entry point to terminal
- Use heuristicLabel (not label) for human-readable community/process names`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cypher query to execute' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'context',
    description: `360-degree view of a single code symbol.
Shows categorized incoming/outgoing references (calls, imports, extends, implements), process participation, and file location.

WHEN TO USE: After query() to understand a specific symbol in depth. When you need to know all callers, callees, and what execution flows a symbol participates in.
AFTER THIS: Use impact() if planning changes, or READ gitnexus://repo/{name}/process/{processName} for full execution trace.

Handles disambiguation: if multiple symbols share the same name, returns candidates for you to pick from. Use uid param for zero-ambiguity lookup from prior results.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (e.g., "validateUser", "AuthService")' },
        uid: { type: 'string', description: 'Direct symbol UID from prior tool results (zero-ambiguity lookup)' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        include_content: { type: 'boolean', description: 'Include full symbol source code (default: false)', default: false },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'detect_changes',
    description: `Analyze uncommitted git changes and find affected execution flows.
Maps git diff hunks to indexed symbols, then traces which processes are impacted.

WHEN TO USE: Before committing — to understand what your changes affect. Pre-commit review, PR preparation.
AFTER THIS: Review affected processes. Use context() on high-risk symbols. READ gitnexus://repo/{name}/process/{name} for full traces.

Returns: changed symbols, affected processes, and a risk summary.`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'What to analyze: "unstaged" (default), "staged", "all", or "compare"', enum: ['unstaged', 'staged', 'all', 'compare'], default: 'unstaged' },
        base_ref: { type: 'string', description: 'Branch/commit for "compare" scope (e.g., "main")' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'rename',
    description: `Multi-file coordinated rename using the knowledge graph + text search.
Finds all references via graph (high confidence) and regex text search (lower confidence). Preview by default.

WHEN TO USE: Renaming a function, class, method, or variable across the codebase. Safer than find-and-replace.
AFTER THIS: Run detect_changes() to verify no unexpected side effects.

Each edit is tagged with confidence:
- "graph": found via knowledge graph relationships (high confidence, safe to accept)
- "text_search": found via regex text search (lower confidence, review carefully)`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name to rename' },
        symbol_uid: { type: 'string', description: 'Direct symbol UID from prior tool results (zero-ambiguity)' },
        new_name: { type: 'string', description: 'The new name for the symbol' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        dry_run: { type: 'boolean', description: 'Preview edits without modifying files (default: true)', default: true },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'impact',
    description: `Analyze the blast radius of changing a code symbol.
Returns affected symbols grouped by depth, plus risk assessment, affected execution flows, and affected modules.

WHEN TO USE: Before making code changes — especially refactoring, renaming, or modifying shared code. Shows what would break.
AFTER THIS: Review d=1 items (WILL BREAK). Use context() on high-risk symbols.

Output includes:
- risk: LOW / MEDIUM / HIGH / CRITICAL
- summary: direct callers, processes affected, modules affected
- affected_processes: which execution flows break and at which step
- affected_modules: which functional areas are hit (direct vs indirect)
- byDepth: all affected symbols grouped by traversal depth

Depth groups:
- d=1: WILL BREAK (direct callers/importers)
- d=2: LIKELY AFFECTED (indirect)
- d=3: MAY NEED TESTING (transitive)

EdgeType: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, OVERRIDES
Confidence: 1.0 = certain, <0.8 = fuzzy match`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of function, class, or file to analyze' },
        direction: { type: 'string', description: 'upstream (what depends on this) or downstream (what this depends on)' },
        maxDepth: { type: 'number', description: 'Max relationship depth (default: 3)', default: 3 },
        relationTypes: { type: 'array', items: { type: 'string' }, description: 'Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, OVERRIDES (default: usage-based)' },
        includeTests: { type: 'boolean', description: 'Include test files (default: false)' },
        minConfidence: { type: 'number', description: 'Minimum confidence 0-1 (default: 0.7)' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['target', 'direction'],
    },
  },
  {
    name: 'semantic_diff',
    description: `Compare AST-level symbol changes between the working tree and a git ref.

Returns a list of symbol changes (Added, Removed, Renamed, SignatureChanged, VisibilityChanged, BodyChanged) with field-level deltas and breaking change classification.

WHEN TO USE: Before a PR or release — understand exactly what changed at the API surface and whether changes are breaking.
AFTER THIS: Use plan_commits() to group the changes into logical commits.

Breaking change rules:
- Breaking: exported symbol was Removed, Renamed, had SignatureChanged or VisibilityChanged
- Not breaking: Added, BodyChanged, or newly exported

Returns: { changes: SymbolChange[], summary: { total, breaking, byKind } }`,
    inputSchema: {
      type: 'object',
      properties: {
        file_paths: { type: 'array', items: { type: 'string' }, description: 'Specific files to diff (default: all staged/unstaged changed files)' },
        ref: { type: 'string', description: 'Git ref to compare against (default: "HEAD")', default: 'HEAD' },
        breaking_only: { type: 'boolean', description: 'Return only breaking changes (default: false)', default: false },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'plan_commits',
    description: `Group staged/unstaged symbol changes into logical commit groups using union-find.

Groups changes by 3 coupling signals: graph call edges (coupled callers/callees), file co-location (same file), and test-source pairing (test file + source file).

WHEN TO USE: When you have changes across multiple files and want help splitting them into clean, atomic commits.
AFTER THIS: Review each group's draftMessage and files, then commit group by group.

Returns: { groups: CommitGroup[], ungrouped: SymbolChange[] }
Each group has: scope, draftMessage, reason, files[], changes[]`,
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Git ref to diff against (default: "HEAD")', default: 'HEAD' },
        scope: { type: 'string', description: 'What to analyze: "unstaged" (default), "staged", "all"', enum: ['unstaged', 'staged', 'all'], default: 'unstaged' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'set_output_format',
    description: `Switch tool output between YAML (default) and JSON.

YAML is more token-efficient and easier to scan. JSON is useful for programmatic consumption.
The setting persists for the session — all subsequent tool calls use the chosen format.`,
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'Output format: "yaml" (default) or "json"', enum: ['yaml', 'json'] },
      },
      required: ['format'],
    },
  },
  {
    name: 'get_code_snippet',
    description: `Fetch disk-fresh source code for a named symbol with surrounding context lines.
Resolves the symbol via 4-tier qualified name lookup (exact QN → QN suffix → name → fuzzy suggestions).
Returns line-numbered source, file location, caller/callee counts, and optional neighbor name lists.

WHEN TO USE: When you need to read the actual implementation of a specific function, class, or method. Prefer this over reading entire files — it fetches only the relevant symbol with context. Use after query() or search_graph() to inspect a result in depth.
AFTER THIS: Use context() for full 360-degree caller/callee view, or impact() before making changes.

Returns: { name, qn, label, file, lines, source, signature, callers, callees, caller_names?, callee_names?, match_method, alternatives? }
- source: line-numbered code ("  42 | func foo() {")
- match_method: exact_qn | qn_suffix | name | suggestions
- alternatives: disambiguation candidates when match_method is "suggestions"`,
    inputSchema: {
      type: 'object',
      properties: {
        qualified_name: { type: 'string', description: 'Qualified name or symbol name to look up (e.g., "AuthService.validateUser" or "validateUser")' },
        context_lines: { type: 'number', description: 'Lines of context before/after the symbol (default: 3)', default: 3 },
        include_neighbors: { type: 'boolean', description: 'Include caller and callee name lists in addition to counts (default: false)', default: false },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['qualified_name'],
    },
  },
  {
    name: 'search_code',
    description: `Text or regex search across all indexed source files with surrounding context lines.
Operates on the indexed file set (File nodes in the graph), not the raw filesystem.
Supports pagination via offset, glob file filtering, and optional regex mode.

WHEN TO USE: Finding all occurrences of a string literal, error message, config key, or pattern across the codebase. Use when you need exact text matches rather than semantic/graph search. Complements query() (semantic) and search_graph() (structural).
AFTER THIS: Use get_code_snippet() to fetch full source for a matched symbol, or context() to understand a matched function's role.

Returns: { pattern, total_matches, limit, offset, has_more, matches[] }
Each match: { file, line, content, context? }`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern to search for' },
        file_pattern: { type: 'string', description: 'Glob pattern to filter files (e.g., "**/*.ts", "src/**/*.py")' },
        max_results: { type: 'number', description: 'Maximum matches to return per page (default: 20, hard cap: 100)', default: 20 },
        offset: { type: 'number', description: 'Number of matches to skip for pagination (default: 0)', default: 0 },
        context_lines: { type: 'number', description: 'Lines of context before/after each match, 0–5 (default: 2)', default: 2 },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default: false)', default: false },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive matching (default: false)', default: false },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'search_graph',
    description: `Structural search over graph nodes with degree, label, and name-pattern filters.
Translates structured params into a Cypher query — no custom query language needed.
Useful for finding dead code (max_degree=0), high fan-in hotspots, or symbols matching a naming pattern.

WHEN TO USE: Finding nodes by structural properties (degree, label, file location, naming convention). Use instead of cypher() for common structural queries. Examples: dead code detection, finding all Handler classes, locating high-coupling hotspots, filtering by file area.
AFTER THIS: Use get_code_snippet() or context() on individual results. Use impact() before modifying hotspots.

Common patterns:
- Dead code: { max_degree: 0, direction: "inbound", exclude_entry_points: true }
- Hotspots: { sort_by: "degree", direction: "inbound", min_degree: 10 }
- By name: { name_pattern: ".*Handler.*", label: "Function" }

Returns: { total, has_more, results[] }
Each result: { name, qn, label, file, lines, in_degree, out_degree }`,
    inputSchema: {
      type: 'object',
      properties: {
        name_pattern: { type: 'string', description: 'Regex pattern to match symbol names (e.g., ".*Handler.*", "^on[A-Z]")' },
        label: { type: 'string', description: 'Node label to filter by (e.g., "Function", "Class", "Method", "Interface")' },
        file_pattern: { type: 'string', description: 'Substring filter on file path (e.g., "src/auth", ".test.")' },
        min_degree: { type: 'number', description: 'Minimum edge count (inclusive) in the specified direction' },
        max_degree: { type: 'number', description: 'Maximum edge count (inclusive) in the specified direction' },
        direction: { type: 'string', description: 'Edge direction for degree counting: "inbound" (callers) or "outbound" (callees)', enum: ['inbound', 'outbound'] },
        sort_by: { type: 'string', description: 'Sort order: "degree" (highest first) or "name" (alphabetical)', enum: ['degree', 'name'] },
        limit: { type: 'number', description: 'Maximum results to return (default: 20)', default: 20 },
        exclude_labels: { type: 'array', items: { type: 'string' }, description: 'Node labels to exclude (default: ["Community", "Process", "Folder"])' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'quality_query',
    description: `Run a pre-built code quality or layer analysis query against the knowledge graph.
Returns raw data — the caller decides what is a smell.

WHEN TO USE: Answering structural code quality questions without writing Cypher:
complexity hotspots, encapsulation violations, DI injection analysis, parameter optionality,
field access patterns, call-chain conditionality (hot path vs guarded branches).

Presets and required/optional parameters:
- high_complexity          — functions with complexity > threshold (threshold required)
- many_optionals           — functions with > threshold optional params (threshold required)
- dead_code                — functions with 0 inbound CALLS (excluding entry points + test files)
- cross_class_field_access — all READS_FIELD/WRITES_FIELD edges that cross class boundaries
- encapsulation_violations — cross-class access to private or protected fields
- unused_injections        — constructor params never referenced by sibling methods
- overused_injections      — constructor params referenced by > 80% of class methods
- params_by_type           — parameters that use a given type (type required)
- param_fan_in             — types ranked by how many parameters reference them
- type_coupling            — classes/interfaces ranked by inbound USES_TYPE count
- layer_violations         — calls from "leaf" nodes (low fan-in) to "entry" nodes (low fan-out)
- god_functions            — functions with high complexity + high fan-out + many params
- throw_diversity          — functions that throw > threshold distinct exception types (threshold required)
- accessor_vs_direct       — field accesses that bypass getters (direct read where a getter exists)
- conditional_calls        — CALLS edges from a given function with conditionality metadata (function required)
- hot_path                 — unconditional call chain from a given function (function required)
- guarded_paths            — conditional call chain from a given function, grouped by guard (function required)

Returns: { preset, results: [...], count }`,
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          description: 'Quality query preset name',
          enum: [
            'high_complexity',
            'many_optionals',
            'dead_code',
            'cross_class_field_access',
            'encapsulation_violations',
            'unused_injections',
            'overused_injections',
            'params_by_type',
            'param_fan_in',
            'type_coupling',
            'layer_violations',
            'god_functions',
            'throw_diversity',
            'accessor_vs_direct',
            'conditional_calls',
            'hot_path',
            'guarded_paths',
          ],
        },
        threshold: {
          type: 'number',
          description: 'Numeric threshold for presets that need one (e.g., complexity > threshold, optional param count > threshold, throw types > threshold)',
        },
        function: {
          type: 'string',
          description: 'Function/method name for presets that target a specific function: conditional_calls, hot_path, guarded_paths',
        },
        type: {
          type: 'string',
          description: 'Type name for the params_by_type preset',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['preset'],
    },
  },
  {
    name: 'get_architecture',
    description: `Multi-aspect architecture overview of the indexed repository.
Each aspect runs targeted Cypher queries and assembles a structured summary.
Request only the aspects you need — each is a separate query.

WHEN TO USE: Onboarding to an unfamiliar codebase, architectural review, understanding tech stack and structure. Use before diving into specific subsystems. More structured than query() for architectural questions.
AFTER THIS: Use query() or search_graph() to drill into a specific area, or READ gitnexus://repo/{name}/clusters for full community breakdown.

Aspects:
- languages: file counts by language
- packages: top-level directories with file/symbol counts
- entry_points: nodes flagged as entry points (main, routes, CLI commands)
- routes: HTTP route definitions grouped by method/path
- hotspots: functions with highest fan-in (most callers)
- boundaries: cross-community call edges (where modules depend on each other)
- services: HTTP_CALLS and ASYNC_CALLS grouped by source/target community
- clusters: auto-detected functional communities (Leiden algorithm)
- all: all of the above

Returns: object with one key per requested aspect, null if aspect has no data.`,
    inputSchema: {
      type: 'object',
      properties: {
        aspects: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['all', 'languages', 'packages', 'entry_points', 'routes', 'hotspots', 'boundaries', 'services', 'clusters'],
          },
          description: 'Aspects to include (default: ["all"]). Subset for faster response.',
        },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
];
