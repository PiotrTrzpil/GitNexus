/**
 * Directory rename for TypeScript/JavaScript projects.
 *
 * Uses ts-morph's SourceFile.move() to relocate every file in a directory
 * and automatically update all import/export paths across the project.
 * Non-TS files in the directory are moved via the filesystem.
 *
 * Error contract (matches ts-morph-rename.ts):
 * - Throws on infrastructure errors (IO, parse, bad tsconfig).
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { findTsConfig, isTypeScriptFile } from './ts-morph-rename.js';

export interface DirectoryRenameEdit {
  filePath: string;
  line: number;
  old_text: string;
  new_text: string;
  confidence: 'ts_morph';
}

export interface DirectoryRenameResult {
  edits: DirectoryRenameEdit[];
  files_moved: { from: string; to: string }[];
}

/** Recursively collect all file paths under `dir`. */
async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Rename (move) a directory and update all import paths.
 *
 * @param opts.repoPath  Absolute path to the repository root.
 * @param opts.oldDir    Old directory path, relative to repoPath (e.g. "src/canvas").
 * @param opts.newDir    New directory path, relative to repoPath (e.g. "src/view").
 * @param opts.dryRun    Preview edits without modifying the filesystem.
 */
export async function directoryRename(opts: {
  repoPath: string;
  oldDir: string;
  newDir: string;
  dryRun: boolean;
}): Promise<DirectoryRenameResult> {
  const { repoPath, oldDir, newDir, dryRun } = opts;

  const absoluteOldDir = path.resolve(repoPath, oldDir);
  const absoluteNewDir = path.resolve(repoPath, newDir);

  // Validate
  const stat = await fs.stat(absoluteOldDir);
  if (!stat.isDirectory()) {
    throw new Error(`${oldDir} is not a directory`);
  }

  try {
    await fs.access(absoluteNewDir);
    throw new Error(`Target directory ${newDir} already exists`);
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      // Good — target doesn't exist
    } else {
      throw e;
    }
  }

  // Collect all files before any modifications
  const allFiles = await collectFiles(absoluteOldDir);
  const tsFiles = allFiles.filter(f => isTypeScriptFile(f));
  const nonTsFiles = allFiles.filter(f => !isTypeScriptFile(f));

  // Build the move map (old absolute → new absolute) for all files
  const moveMap = new Map<string, string>();
  for (const absFile of allFiles) {
    const relativeToOld = path.relative(absoluteOldDir, absFile);
    moveMap.set(absFile, path.join(absoluteNewDir, relativeToOld));
  }

  const edits: DirectoryRenameEdit[] = [];
  const filesMoved: { from: string; to: string }[] = [];

  // --- TypeScript files: use ts-morph to move + update imports ---
  if (tsFiles.length > 0) {
    const { Project } = await import('ts-morph');

    const tsConfigPath = await findTsConfig(repoPath, absoluteOldDir + path.sep);

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

    // Ensure all TS files in the old directory are loaded
    for (const absFile of tsFiles) {
      if (!project.getSourceFile(absFile)) {
        project.addSourceFileAtPath(absFile);
      }
    }

    // Snapshot all file texts before the move
    const snapshots = new Map<string, string>();
    for (const sf of project.getSourceFiles()) {
      snapshots.set(sf.getFilePath(), sf.getFullText());
    }

    // Move each source file in the old directory to the new location
    for (const absFile of tsFiles) {
      const sf = project.getSourceFile(absFile);
      if (!sf) continue;
      const newPath = moveMap.get(absFile)!;
      sf.move(newPath);
      filesMoved.push({
        from: path.relative(repoPath, absFile),
        to: path.relative(repoPath, newPath),
      });
    }

    // Compute import-path edits by diffing every modified file
    for (const sf of project.getSourceFiles()) {
      const currentPath = sf.getFilePath();
      const newText = sf.getFullText();

      // Find the original text — either this file existed at this path,
      // or it was moved here from the old directory
      let originalText: string | undefined;

      if (snapshots.has(currentPath)) {
        // Non-moved file whose imports may have been updated
        originalText = snapshots.get(currentPath)!;
      } else {
        // Moved file — find original snapshot by old path
        for (const [oldAbs, newAbs] of moveMap) {
          if (currentPath === newAbs || path.resolve(currentPath) === path.resolve(newAbs)) {
            originalText = snapshots.get(oldAbs);
            break;
          }
        }
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

      // ts-morph's save writes new files but doesn't always remove old ones.
      // Clean up old TS files that were moved.
      for (const absFile of tsFiles) {
        try {
          await fs.access(absFile);
          await fs.unlink(absFile);
        } catch {
          // Already gone — ts-morph handled it
        }
      }
    }
  }

  // --- Non-TS files: move via filesystem ---
  for (const absFile of nonTsFiles) {
    const newPath = moveMap.get(absFile)!;
    filesMoved.push({
      from: path.relative(repoPath, absFile),
      to: path.relative(repoPath, newPath),
    });

    if (!dryRun) {
      await fs.mkdir(path.dirname(newPath), { recursive: true });
      await fs.rename(absFile, newPath);
    }
  }

  // Clean up empty old directory tree after move
  if (!dryRun) {
    await removeEmptyDirs(absoluteOldDir);
  }

  return { edits, files_moved: filesMoved };
}

/** Recursively remove a directory tree if all subdirs are empty. */
async function removeEmptyDirs(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await removeEmptyDirs(path.join(dir, entry.name));
      }
    }
    // Try to remove — fails if non-empty (files remain), which is fine
    await fs.rmdir(dir);
  } catch {
    // Directory not empty or already gone
  }
}
