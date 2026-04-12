/**
 * AI Context Generator
 * 
 * Creates AGENTS.md and CLAUDE.md with full inline GitNexus context.
 * AGENTS.md is the standard read by Cursor, Windsurf, OpenCode, Cline, etc.
 * CLAUDE.md is for Claude Code which only reads that file.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { type GeneratedSkillInfo } from './skill-gen.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RepoStats {
  files?: number;
  nodes?: number;
  edges?: number;
  communities?: number;
  clusters?: number;       // Aggregated cluster count (what tools show)
  processes?: number;
}

const GITNEXUS_START_MARKER = '<!-- gitnexus:start -->';
const GITNEXUS_END_MARKER = '<!-- gitnexus:end -->';

/**
 * Generate the GitNexus context block injected into AGENTS.md / CLAUDE.md.
 *
 * Keep it short: agents drop rules past ~150 lines, and the linked skill
 * files carry the detailed workflows. This block is a pointer + core rules.
 */
function generateGitNexusContent(projectName: string, stats: RepoStats, generatedSkills?: GeneratedSkillInfo[]): string {
  const generatedRows = (generatedSkills && generatedSkills.length > 0)
    ? '\n' + generatedSkills.map(s =>
        `| ${s.label} area (${s.symbolCount} symbols) | \`.claude/skills/generated/${s.name}/SKILL.md\` |`
      ).join('\n')
    : '';

  return `${GITNEXUS_START_MARKER}
# GitNexus — Code Intelligence

Indexed as **${projectName}** (${stats.nodes || 0} symbols, ${stats.edges || 0} relationships, ${stats.processes || 0} execution flows). Prefer GitNexus MCP tools over grep/glob for structural questions. If a tool warns the index is stale, run \`gitnexus analyze\`.

## Always

- MUST run \`gitnexus_impact({target, direction: "upstream"})\` before editing any function/class/method and report the blast radius.
- MUST run \`gitnexus_detect_changes()\` before committing to verify scope.
- MUST warn the user on HIGH/CRITICAL impact risk.
- Use \`gitnexus_query\` / \`gitnexus_context\` to explore unfamiliar code — not grep.

## Never

- NEVER edit a symbol without running \`gitnexus_impact\` first.
- NEVER ignore HIGH/CRITICAL risk warnings.
- NEVER rename with find-and-replace — use \`gitnexus_rename\` (read the refactoring skill first).
- NEVER commit without running \`gitnexus_detect_changes\`.

## Renaming

**MUST read \`.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md\` before any rename operation.**
The rename tool has an \`engine\` parameter that controls matching strictness. Default is safe (no text_search). Use \`engine: "with_text_search"\` only with caution — it does blind regex matching.

## Tools

| Tool | Use for |
|------|---------|
| \`query\` | Natural-language code search, ranked by execution flow |
| \`context\` | Callers, callees, process participation for a symbol |
| \`impact\` | Blast radius before editing (depth d=1 WILL BREAK) |
| \`detect_changes\` | Map a diff to affected symbols and flows |
| \`rename\` | Safe multi-file rename — **read refactoring skill first** |
| \`cypher\` | Custom graph queries |

## Skills

| Task | Read |
|------|------|
| Architecture / "How does X work?" | \`.claude/skills/gitnexus/gitnexus-exploring/SKILL.md\` |
| "What breaks if I change X?" | \`.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md\` |
| Debugging / "Why is X failing?" | \`.claude/skills/gitnexus/gitnexus-debugging/SKILL.md\` |
| Rename / extract / refactor | \`.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md\` |
| Tools and schema reference | \`.claude/skills/gitnexus/gitnexus-guide/SKILL.md\` |
| CLI (analyze, embeddings, wiki) | \`.claude/skills/gitnexus/gitnexus-cli/SKILL.md\` |${generatedRows}
${GITNEXUS_END_MARKER}`;
}


/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or update GitNexus section in a file
 * - If file doesn't exist: create with GitNexus content
 * - If file exists without GitNexus section: append
 * - If file exists with GitNexus section: replace that section
 */
async function upsertGitNexusSection(
  filePath: string,
  content: string
): Promise<'created' | 'updated' | 'appended'> {
  const exists = await fileExists(filePath);

  if (!exists) {
    await fs.writeFile(filePath, content, 'utf-8');
    return 'created';
  }

  const existingContent = await fs.readFile(filePath, 'utf-8');

  // Check if GitNexus section already exists
  const startIdx = existingContent.indexOf(GITNEXUS_START_MARKER);
  const endIdx = existingContent.indexOf(GITNEXUS_END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing section
    const before = existingContent.substring(0, startIdx);
    const after = existingContent.substring(endIdx + GITNEXUS_END_MARKER.length);
    const newContent = before + content + after;
    await fs.writeFile(filePath, newContent.trim() + '\n', 'utf-8');
    return 'updated';
  }

  // Append new section
  const newContent = existingContent.trim() + '\n\n' + content + '\n';
  await fs.writeFile(filePath, newContent, 'utf-8');
  return 'appended';
}

/**
 * Install GitNexus skills to .claude/skills/gitnexus/
 * Works natively with Claude Code, Cursor, and GitHub Copilot
 */
async function installSkills(repoPath: string): Promise<string[]> {
  const skillsDir = path.join(repoPath, '.claude', 'skills', 'gitnexus');
  const installedSkills: string[] = [];

  // Skill definitions bundled with the package
  const skills = [
    {
      name: 'gitnexus-exploring',
      description: 'Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: "How does X work?", "What calls this function?", "Show me the auth flow"',
    },
    {
      name: 'gitnexus-debugging',
      description: 'Use when the user is debugging a bug, tracing an error, or asking why something fails. Examples: "Why is X failing?", "Where does this error come from?", "Trace this bug"',
    },
    {
      name: 'gitnexus-impact-analysis',
      description: 'Use when the user wants to know what will break if they change something, or needs safety analysis before editing code. Examples: "Is it safe to change X?", "What depends on this?", "What will break?"',
    },
    {
      name: 'gitnexus-refactoring',
      description: 'Use when the user wants to rename, extract, split, move, or restructure code safely. Examples: "Rename this function", "Extract this into a module", "Refactor this class", "Move this to a separate file"',
    },
    {
      name: 'gitnexus-guide',
      description: 'Use when the user asks about GitNexus itself — available tools, how to query the knowledge graph, MCP resources, graph schema, or workflow reference. Examples: "What GitNexus tools are available?", "How do I use GitNexus?"',
    },
    {
      name: 'gitnexus-cli',
      description: 'Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: "Index this repo", "Reanalyze the codebase", "Generate a wiki"',
    },
  ];

  for (const skill of skills) {
    const skillDir = path.join(skillsDir, skill.name);
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      // Create skill directory
      await fs.mkdir(skillDir, { recursive: true });

      // Try to read from package skills directory
      const packageSkillPath = path.join(__dirname, '..', '..', 'skills', `${skill.name}.md`);
      let skillContent: string;

      try {
        skillContent = await fs.readFile(packageSkillPath, 'utf-8');
      } catch {
        // Fallback: generate minimal skill content
        skillContent = `---
name: ${skill.name}
description: ${skill.description}
---

# ${skill.name.charAt(0).toUpperCase() + skill.name.slice(1)}

${skill.description}

Use GitNexus tools to accomplish this task.
`;
      }

      await fs.writeFile(skillPath, skillContent, 'utf-8');
      installedSkills.push(skill.name);
    } catch (err) {
      // Skip on error, don't fail the whole process
      console.warn(`Warning: Could not install skill ${skill.name}:`, err);
    }
  }

  return installedSkills;
}

/**
 * Generate AI context files after indexing
 */
export async function generateAIContextFiles(
  repoPath: string,
  _storagePath: string,
  projectName: string,
  stats: RepoStats,
  generatedSkills?: GeneratedSkillInfo[]
): Promise<{ files: string[] }> {
  const content = generateGitNexusContent(projectName, stats, generatedSkills);
  const createdFiles: string[] = [];

  // Create AGENTS.md (standard for Cursor, Windsurf, OpenCode, Cline, etc.)
  const agentsPath = path.join(repoPath, 'AGENTS.md');
  const agentsResult = await upsertGitNexusSection(agentsPath, content);
  createdFiles.push(`AGENTS.md (${agentsResult})`);

  // Create CLAUDE.md (for Claude Code)
  const claudePath = path.join(repoPath, 'CLAUDE.md');
  const claudeResult = await upsertGitNexusSection(claudePath, content);
  createdFiles.push(`CLAUDE.md (${claudeResult})`);

  // Install skills to .claude/skills/gitnexus/
  const installedSkills = await installSkills(repoPath);
  if (installedSkills.length > 0) {
    createdFiles.push(`.claude/skills/gitnexus/ (${installedSkills.length} skills)`);
  }

  return { files: createdFiles };
}

