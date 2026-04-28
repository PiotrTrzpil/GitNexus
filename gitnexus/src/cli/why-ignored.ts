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
  isHardcodedIgnoredDirectory,
  isHardcodedFileExclusion,
  loadIgnoreRules,
} from '../config/ignore-service.js';

type Verdict = {
  reason: string;
  source: 'default-list';
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

const explainHardcodedDirectoryRule = (rel: string): Verdict | null => {
  const parts = rel.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    if (isHardcodedIgnoredDirectory(part)) {
      return {
        reason: `path segment "${part}" is in the hardcoded DEFAULT_IGNORE_LIST. Override with "!${part}/" in .gitnexusignore.`,
        source: 'default-list',
      };
    }
  }
  return null;
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

  // 1. Binary/non-source file exclusions — apply BEFORE user override.
  //    PNG, lock files, .min.js, etc. are never source, even if git tracks them.
  if (isHardcodedFileExclusion(rel)) {
    process.stdout.write(`  ignored: hardcoded file exclusion (binary type, lock file, or generated)\n`);
    process.stdout.write(`  source:  extension/filename\n`);
    process.stdout.write(`  note:    user negations in .gitignore/.gitnexusignore do NOT override this\n`);
    return;
  }

  // 2. User .gitignore / .gitnexusignore — explicit unignore wins for dir-level rules.
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

  // 3. Hardcoded DEFAULT_IGNORE_LIST (directories).
  const hardcoded = explainHardcodedDirectoryRule(rel);
  if (hardcoded) {
    process.stdout.write(`  ignored: ${hardcoded.reason}\n`);
    process.stdout.write(`  source:  ${hardcoded.source}\n`);
    return;
  }

  // 4. Hidden files (glob's `dot: false` strips these even without ignore rules).
  const fileName = rel.split('/').pop() ?? '';
  if (fileName.startsWith('.')) {
    process.stdout.write(`  ignored: hidden file (filesystem walker uses dot:false)\n`);
    process.stdout.write(`  source:  hidden\n`);
    return;
  }

  process.stdout.write(`  not ignored — should be indexed\n`);
}
