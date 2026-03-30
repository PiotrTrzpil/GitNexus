/**
 * Single-file rename/move for TypeScript/JavaScript projects.
 *
 * Uses ts-morph's SourceFile.move() to relocate a single file
 * and automatically update all import/export paths across the project.
 * Non-TS files are moved via the filesystem (no import rewriting).
 *
 * Error contract (matches directory-rename.ts):
 * - Throws on infrastructure errors (IO, parse, bad tsconfig).
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { findTsConfig, isTypeScriptFile } from './ts-morph-rename.js';

export interface FileRenameEdit {
  filePath: string;
  line: number;
  old_text: string;
  new_text: string;
  confidence: 'ts_morph';
}

export interface FileRenameResult {
  edits: FileRenameEdit[];
  files_moved: { from: string; to: string }[];
}

/**
 * Rename (move) a single file and update all import paths.
 *
 * @param opts.repoPath   Absolute path to the repository root.
 * @param opts.oldFile    Old file path, relative to repoPath (e.g. "src/utils/helpers.ts").
 * @param opts.newFile    New file path, relative to repoPath (e.g. "src/lib/helpers.ts").
 * @param opts.dryRun     Preview edits without modifying the filesystem.
 */
export async function fileRename(opts: {
  repoPath: string;
  oldFile: string;
  newFile: string;
  dryRun: boolean;
}): Promise<FileRenameResult> {
  const { repoPath, oldFile, newFile, dryRun } = opts;

  const absoluteOldFile = path.resolve(repoPath, oldFile);
  const absoluteNewFile = path.resolve(repoPath, newFile);

  // Validate source exists and is a file
  const stat = await fs.stat(absoluteOldFile);
  if (!stat.isFile()) {
    throw new Error(`${oldFile} is not a file`);
  }

  // Validate target doesn't already exist
  try {
    await fs.access(absoluteNewFile);
    throw new Error(`Target file ${newFile} already exists`);
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      // Good — target doesn't exist
    } else {
      throw e;
    }
  }

  const edits: FileRenameEdit[] = [];
  const filesMoved: { from: string; to: string }[] = [
    { from: oldFile, to: newFile },
  ];

  // --- TS/JS file: use ts-morph to move + update imports ---
  if (isTypeScriptFile(absoluteOldFile)) {
    const { Project } = await import('ts-morph');

    const tsConfigPath = await findTsConfig(repoPath, absoluteOldFile);

    const project = tsConfigPath
      ? new Project({ tsConfigFilePath: tsConfigPath })
      : new Project({
          compilerOptions: { allowJs: true, checkJs: false, noEmit: true },
        });

    // Add source files if no tsconfig
    if (!tsConfigPath) {
      project.addSourceFilesAtPaths([
        path.join(repoPath, 'src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'),
        path.join(repoPath, 'lib/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'),
        path.join(repoPath, '*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'),
      ]);
    }

    // Ensure the file is loaded
    if (!project.getSourceFile(absoluteOldFile)) {
      project.addSourceFileAtPath(absoluteOldFile);
    }

    // Snapshot all file texts before the move
    const snapshots = new Map<string, string>();
    for (const sf of project.getSourceFiles()) {
      snapshots.set(sf.getFilePath(), sf.getFullText());
    }

    // Move the source file to the new location
    const sf = project.getSourceFile(absoluteOldFile);
    if (sf) {
      sf.move(absoluteNewFile);
    }

    // Compute import-path edits by diffing every modified file
    for (const sourcefile of project.getSourceFiles()) {
      const currentPath = sourcefile.getFilePath();
      const newText = sourcefile.getFullText();

      // Find the original text
      let originalText: string | undefined;

      if (snapshots.has(currentPath)) {
        // Non-moved file whose imports may have been updated
        originalText = snapshots.get(currentPath)!;
      } else if (
        currentPath === absoluteNewFile ||
        path.resolve(currentPath) === path.resolve(absoluteNewFile)
      ) {
        // The moved file — find original snapshot by old path
        originalText = snapshots.get(absoluteOldFile);
      }

      if (!originalText || originalText === newText) continue;

      // Line-by-line diff to extract individual edits
      const oldLines = originalText.split('\n');
      const newLines = newText.split('\n');
      const reportPath = path.relative(repoPath, currentPath);

      for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
        const oldLine = oldLines[i];
        const newLine = newLines[i];
        if (oldLine !== newLine) {
          edits.push({
            filePath: reportPath,
            line: i + 1,
            old_text: (oldLine ?? '').trim(),
            new_text: (newLine ?? '').trim(),
            confidence: 'ts_morph',
          });
        }
      }
    }

    // Apply if not dry run
    if (!dryRun) {
      await project.save();

      // ts-morph's save writes the new file but doesn't always remove the old one.
      try {
        await fs.access(absoluteOldFile);
        await fs.unlink(absoluteOldFile);
      } catch {
        // Already gone — ts-morph handled it
      }

      // Clean up empty parent directories left behind
      await removeEmptyParents(absoluteOldFile, repoPath);
    }
  } else {
    // --- Non-TS file: move via filesystem ---
    if (!dryRun) {
      await fs.mkdir(path.dirname(absoluteNewFile), { recursive: true });
      await fs.rename(absoluteOldFile, absoluteNewFile);

      // Clean up empty parent directories left behind
      await removeEmptyParents(absoluteOldFile, repoPath);
    }
  }

  return { edits, files_moved: filesMoved };
}

/**
 * Remove empty parent directories from a deleted file up to (but not including) stopAt.
 */
async function removeEmptyParents(filePath: string, stopAt: string): Promise<void> {
  let dir = path.dirname(filePath);
  while (dir.length > stopAt.length && dir.startsWith(stopAt)) {
    try {
      const entries = await fs.readdir(dir);
      if (entries.length > 0) break; // not empty
      await fs.rmdir(dir);
      dir = path.dirname(dir);
    } catch {
      break;
    }
  }
}
