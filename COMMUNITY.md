# Community Contributions — Open PRs & Fork Activity

Snapshot taken 2026-03-15. 1,605 forks total; most are inactive mirrors.

---

## Core Indexing & Analysis

| PR | Author | Description |
|----|--------|-------------|
| #286 | @dp-web4 | **Markdown file indexing** — headings become `Section` nodes, cross-file links become `IMPORTS` edges. Regex-based, no tree-sitter dep. Tested on 1,104 `.md` files (17,659 sections). |
| #284 | @magyargergo | **Return type inference + doc-comment parsing** — JSDoc, PHPDoc, YARD `@return`/`@param` extraction. Per-language constructor binding scanners for all 12 languages. Conservative: only triggers for unambiguous callees. 4,693 additions across 128 files. |
| #141 | @PurpleNewNew | **Hunk-level `detect_changes`** — upgrades from file-level to line-range symbol mapping. Adds `UNINDEXED:<file>` fallback nodes, change types (Modified/Added/Deleted/Renamed), per-symbol `changed_ranges`. |
| #119 | @PurpleNewNew | **Multi-signal query ranking** — `query` tool now uses `task_context` (0.45) and `goal` (0.75) weights alongside `query` (1.0). Deduplicates signals, merges via weighted Reciprocal Rank Fusion. |
| #172 | @chouzz | **File scanning performance** — early filtering during scan for large monorepos (skips Bazel dirs etc. before traversal instead of after). |
| #107 | @CrazyBunQnQ | **Embedded node restriction options** — CLI flags to allow more embedded nodes for large projects. |

## `.gitnexusignore` Support (5 competing PRs)

| PR | Author | Notes |
|----|--------|-------|
| #231 | @ivkond | **Most complete** — respects both `.gitignore` and `.gitnexusignore`, directory-level pruning via `childrenIgnored`, no unnecessary `stat()` calls. |
| #203 | @L1nusB | Adds `--no-user-ignore` override flag. |
| #246 | @2233admin | Uses `ignore` npm package, applied in `walkRepositoryPaths()`. |
| #233 | @ex-nihilo-jg | Minimal implementation. |
| #86 | @ajmeese7 | Original proposal with real-world motivation (vendored QuestDB bundle noise). |

## Web UI

| PR | Author | Description |
|----|--------|-------------|
| #167 | @Yogesh1290 | **In-browser execution via WebContainers** — run code directly from the graph UI. Integrates `gitnexus-bundler` for instant boot (<5s). 24,329 additions. [Video demo](https://youtu.be/hjlBrGLujPA). |
| #148 | @Rocky0102 | **Multi-repo switching** — `currentRepoName` state tracking, server-mode query execution with repo param, fixes HTTP endpoint paths. |
| #202 | @madmansn0w | **Server-mode query routing** — routes Cypher queries through backend HTTP instead of local WASM DB. |
| #201 | @madmansn0w | **API URL normalization** — fixes double `/api/api/` path bug + legacy flat-array search response compat. |
| #199 | @madmansn0w | **Backend agent init** — fixes stalled "Initializing Agent" and false "empty codebase" in server mode. |

## CLI & Setup

| PR | Author | Description |
|----|--------|-------------|
| #114 | @gentritbiba | **`gitnexus uninstall` command** — reverses `setup` + `analyze`. Removes per-repo artifacts, global configs, hooks, skills. Supports `--global`, `--all`, `--dry-run`. |
| #214 | @L1nusB | **Centralize skill definitions** — single source of truth in `gitnexus/skills/`, build-time sync script generates derived copies. Fixes drift across 4 locations. |
| #210 | @L1nusB | **Unify skill installation** — removes skill install from `analyze`, makes `setup` the single owner. Auto-discovers from disk instead of hardcoded list. Fixes duplicate skill bug. |
| #232 | @ex-nihilo-jg | **`--mcp-only` flag** — run `analyze` without generating CLAUDE.md/skills/hooks. |
| #248 | @2233admin | **`--no-hooks` / `--no-skills` flags** — granular control over `setup` side effects. |
| #223 | @hiSandog | **Enhanced `list` command** — `--json`, `--sort` (name/date/files/symbols), `--filter`. |
| #250 | @2233admin | **`serve` cwd resolution** — matches current working directory against indexed repos instead of defaulting to first. |
| #249 | @2233admin | **OpenCode MCP config format fix** — generates `{ type: "local", command: [...] }` instead of `{ command, args }`. |

## Bug Fixes

| PR | Author | Description |
|----|--------|-------------|
| #296 | @youxufkhan | **ONNX embeddings crash** — force CPU execution provider when CUDA unavailable (Node.js v20.x). |
| #261 | @Gujiassh | **Worker warnings non-terminal** — `type: 'warning'` messages no longer kill worker dispatch. |
| #260 | @Gujiassh | **React component path casing** — preserve PascalCase before framework detection so `views/Button.tsx` matches React heuristic. |
| #252 | @2233admin | **Wiki context overflow** — chunk file grouping when >100K tokens. Groups by top-level dir for coherence. |
| #235 | @deathkel | **Skip non-regular paths** — FIFO/socket/device files no longer block `analyze`. |
| #229 | @starrylee | **Backtick escaping in wiki HTML** — `JSON.stringify` doesn't escape backticks inside `<script>` tags. |
| #200 | @L1nusB | **Hook `--` pattern parsing** — patterns starting with `--` no longer interpreted as CLI flags. |
| #175 | @lehenbauer | **Force-exit after analyze** — prevents KuzuDB destructor hang. |
| #154 | @LckyLke | **Skip unsupported languages** — graceful skip instead of crash when tree-sitter grammar missing. |
| #109 | @atul-trycoral | **Hook CLI path resolution** — falls back to `which`/`npm root -g` when relative path fails after `setup`. |
| #93 | @xuelanghanbao | **Duplicate `ftsLoaded` declaration** — removes duplicate that broke typecheck. |
| #81 | @reckless129 | **Version sync** — package.json vs CLI version mismatch. |

## Unpublished Fork Work (no PR yet)

| Fork | Branch | Description |
|------|--------|-------------|
| octo-patch/GitNexus | `MCP-bridge` | **Hub & Spoke multi-agent architecture** — single port, multi-agent MCP support. |
| octo-patch/GitNexus | `feat/webGL` | **WebGL graph rendering** — alternative to current canvas renderer. |
| M40k1n9/MyGitNexus | `chanzi-m1-framework-coverage` | **Dataflow neighborhood panel** + test coverage metrics. |
