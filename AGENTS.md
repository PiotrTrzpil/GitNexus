<!-- gitnexus:start -->
# GitNexus — Code Intelligence

Indexed as **GitNexus**. Prefer GitNexus MCP tools over grep/glob for structural questions. If a tool warns the index is stale, run `gitnexus analyze`. Index stats live in `.gitnexus/stats.md`.

## Always

- MUST run `gitnexus_impact({target, direction: "upstream"})` before editing any function/class/method and report the blast radius.
- MUST run `gitnexus_detect_changes()` before committing to verify scope.
- MUST warn the user on HIGH/CRITICAL impact risk.
- Use `gitnexus_query` / `gitnexus_context` to explore unfamiliar code — not grep.

## Never

- NEVER edit a symbol without running `gitnexus_impact` first.
- NEVER ignore HIGH/CRITICAL risk warnings.
- NEVER rename with find-and-replace — use `gitnexus_rename` (read the refactoring skill first).
- NEVER commit without running `gitnexus_detect_changes`.

## Renaming

**MUST read `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` before any rename operation.**
The rename tool has an `engine` parameter that controls matching strictness. Default is safe (no text_search). Use `engine: "with_text_search"` only with caution — it does blind regex matching.

## Tools

| Tool | Use for |
|------|---------|
| `query` | Natural-language code search, ranked by execution flow |
| `context` | Callers, callees, process participation for a symbol |
| `impact` | Blast radius before editing (depth d=1 WILL BREAK) |
| `detect_changes` | Map a diff to affected symbols and flows |
| `rename` | Safe multi-file rename — **read refactoring skill first** |
| `cypher` | Custom graph queries |

## Skills

| Task | Read |
|------|------|
| Architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Debugging / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools and schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| CLI (analyze, embeddings, wiki) | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
<!-- gitnexus:end -->

# Package tests (`gitnexus/`)

Package scripts live in `gitnexus/package.json`. Use **pnpm** (not npm).

| Script | What it runs |
|--------|----------------|
| `pnpm test` | All unit tests (`test/unit`) |
| `pnpm test:integration` | **Entire** integration suite (`test/integration`) — slow |
| `pnpm test:all` | Unit + integration |
| `pnpm test:watch` | Vitest watch mode |

## Running a subset of tests (correct)

`pnpm test` / `pnpm test:integration` already pass a directory to vitest. Extra path args after `--` do **not** narrow the run — you still get the whole suite.

**Wrong** (runs everything under `test/integration`, can take minutes):

```bash
cd gitnexus
pnpm test:integration -- test/integration/python-file-move.test.ts
# expands to: vitest run test/integration -- test/integration/python-file-move.test.ts
```

**Right** — invoke vitest with only the files or globs you want:

```bash
cd gitnexus

# One file
pnpm exec vitest run test/integration/python-file-move.test.ts

# Several files
pnpm exec vitest run test/integration/file-rename.test.ts test/integration/directory-rename.test.ts

# Name filter within a path
pnpm exec vitest run test/integration -t "rope"

# Unit only, one file
pnpm exec vitest run test/unit/graph.test.ts
```

Prefer partial runs while iterating; use full `pnpm test` / `pnpm test:integration` before commit or when validating broad changes.
