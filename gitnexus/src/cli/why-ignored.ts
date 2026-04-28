/**
 * Diagnostic for "why isn't X being indexed?"
 *
 * Walks the same ignore checks createIgnoreFilter() applies during analyze,
 * in the same order, and reports which rule (if any) excluded the path.
 *
 * Usage: gitnexus why-ignored src/some/file.ts
 */

import fs from 'fs/promises';
import nodePath from 'path';
import {
  shouldIgnorePath,
  isHardcodedIgnoredDirectory,
  loadIgnoreRules,
} from '../config/ignore-service.js';

type Verdict = {
  reason: string;
  source: 'gitignore' | 'gitnexusignore' | 'default-list' | 'extension' | 'filename' | 'pattern' | 'hidden';
};

async function findRepoRoot(start: string): Promise<string> {
  let dir = nodePath.resolve(start);
  while (true) {
    try {
      const s = await fs.stat(nodePath.join(dir, '.git'));
      if (s.isDirectory() || s.isFile()) return dir;
    } catch { /* not a repo root, keep walking */ }
    const parent = nodePath.dirname(dir);
    if (parent === dir) return nodePath.resolve(start);  // give up, use cwd
    dir = parent;
  }
}

const explainHardcodedRule = (rel: string): Verdict | null => {
  const parts = rel.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    if (isHardcodedIgnoredDirectory(part)) {
      return {
        reason: `path segment "${part}" is in the hardcoded DEFAULT_IGNORE_LIST. Override with "!${part}/" in .gitnexusignore.`,
        source: 'default-list',
      };
    }
  }
  if (!shouldIgnorePath(rel)) return null;

  const fileName = parts[parts.length - 1];
  const lower = fileName.toLowerCase();
  const lastDot = lower.lastIndexOf('.');
  if (lastDot !== -1) {
    return {
      reason: `extension "${lower.substring(lastDot)}" or compound extension is in IGNORED_EXTENSIONS`,
      source: 'extension',
    };
  }
  return { reason: 'matched IGNORED_FILES or pattern check', source: 'pattern' };
};

export async function whyIgnoredCommand(targetPath: string): Promise<void> {
  if (!targetPath?.trim()) {
    console.error('Usage: gitnexus why-ignored <path>');
    process.exit(1);
  }

  const cwd = process.cwd();
  const abs = nodePath.resolve(cwd, targetPath);
  const repoRoot = await findRepoRoot(cwd);
  const rel = nodePath.relative(repoRoot, abs).replace(/\\/g, '/');

  if (!rel || rel.startsWith('..')) {
    console.error(`Path "${targetPath}" is outside repo root ${repoRoot}`);
    process.exit(1);
  }

  process.stdout.write(`repo:   ${repoRoot}\npath:   ${rel}\n\n`);

  // 1. User .gitignore / .gitnexusignore — explicit unignore wins over everything.
  const ig = await loadIgnoreRules(repoRoot);
  if (ig) {
    const r = ig.test(rel);
    if (r.unignored) {
      process.stdout.write(`  not ignored: explicit negation in .gitignore/.gitnexusignore\n`);
      return;
    }
    if (r.ignored) {
      process.stdout.write(`  ignored: matched a rule in .gitignore or .gitnexusignore\n`);
      process.stdout.write(`  hint:    grep your ignore files for the matching pattern\n`);
      return;
    }
  }

  // 2. Hardcoded DEFAULT_IGNORE_LIST / extensions / filenames.
  const hardcoded = explainHardcodedRule(rel);
  if (hardcoded) {
    process.stdout.write(`  ignored: ${hardcoded.reason}\n`);
    process.stdout.write(`  source:  ${hardcoded.source}\n`);
    return;
  }

  // 3. Hidden files (glob's `dot: false` strips these even without ignore rules).
  const fileName = rel.split('/').pop() ?? '';
  if (fileName.startsWith('.')) {
    process.stdout.write(`  ignored: hidden file (filesystem walker uses dot:false)\n`);
    process.stdout.write(`  source:  hidden\n`);
    return;
  }

  process.stdout.write(`  not ignored — should be indexed\n`);
}
