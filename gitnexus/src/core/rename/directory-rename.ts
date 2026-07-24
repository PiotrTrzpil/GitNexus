/**
 * Directory rename / package move.
 *
 * - TypeScript/JavaScript: ts-morph SourceFile.move() rewrites import/export paths.
 * - Python (no TS in the tree): rope package move rewrites imports for the whole tree.
 * - Mixed TS + Python: TS via ts-morph; each Python module via rope; other files via fs.
 * - Other non-code files: filesystem move only.
 *
 * Error contract (matches ts-morph-rename.ts):
 * - Throws on infrastructure errors (IO, parse, bad tsconfig, rope failures).
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { findTsConfig, isTypeScriptFile } from './ts-morph-rename.js';
import { isPythonFile, ropeMove } from './rope-rename.js';
import { renameLogger } from '../../util/logger.js';

export interface DirectoryRenameEdit {
  filePath: string;
  line: number;
  old_text: string;
  new_text: string;
  confidence: 'ts_morph' | 'rope';
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
    renameLogger.error({ oldDir }, 'Source is not a directory');
    throw new Error(`${oldDir} is not a directory`);
  }

  try {
    await fs.access(absoluteNewDir);
    renameLogger.error({ newDir }, 'Target directory already exists');
    throw new Error(`Target directory ${newDir} already exists`);
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      // Good — target doesn't exist
    } else {
      renameLogger.error({ err: e, newDir }, 'Error checking target directory');
      throw e;
    }
  }

  // Collect all files before any modifications
  const allFiles = await collectFiles(absoluteOldDir);
  const tsFiles = allFiles.filter(f => isTypeScriptFile(f));
  const pyFiles = allFiles.filter(f => isPythonFile(f));
  const otherFiles = allFiles.filter(f => !isTypeScriptFile(f) && !isPythonFile(f));

  // Build the move map (old absolute → new absolute) for all files
  const moveMap = new Map<string, string>();
  for (const absFile of allFiles) {
    const relativeToOld = path.relative(absoluteOldDir, absFile);
    moveMap.set(absFile, path.join(absoluteNewDir, relativeToOld));
  }

  const edits: DirectoryRenameEdit[] = [];
  const filesMoved: { from: string; to: string }[] = [];

  // --- Python-only tree (may include assets): single rope package move ---
  // Rope moves the whole directory and rewrites Python imports. Prefer this when
  // there is no TS/JS so we get correct package-level import updates.
  if (pyFiles.length > 0 && tsFiles.length === 0) {
    const result = await ropeMove({
      repoPath,
      oldPath: oldDir.replace(/\\/g, '/'),
      newPath: newDir.replace(/\\/g, '/'),
      dryRun,
    });

    edits.push(
      ...result.edits.map((e) => ({
        filePath: e.filePath,
        line: e.line,
        old_text: e.old_text,
        new_text: e.new_text,
        confidence: 'rope' as const,
      })),
    );

    if (result.files_moved.length > 0) {
      filesMoved.push(...result.files_moved);
    } else {
      for (const absFile of allFiles) {
        const newPath = moveMap.get(absFile)!;
        filesMoved.push({
          from: path.relative(repoPath, absFile),
          to: path.relative(repoPath, newPath),
        });
      }
    }

    // If rope only reported Python moves, still move leftover non-py assets via fs
    // (package-level rope move usually relocates the whole tree already).
    if (!dryRun) {
      for (const absFile of otherFiles) {
        const newPath = moveMap.get(absFile)!;
        const alreadyMoved = filesMoved.some(
          (m) => path.resolve(repoPath, m.from) === path.resolve(absFile),
        );
        if (alreadyMoved) continue;
        try {
          await fs.access(absFile);
        } catch {
          continue; // already gone with the package move
        }
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        await fs.rename(absFile, newPath);
        filesMoved.push({
          from: path.relative(repoPath, absFile),
          to: path.relative(repoPath, newPath),
        });
      }
      await removeEmptyDirs(absoluteOldDir);
    }

    return { edits, files_moved: filesMoved };
  }

  // --- TypeScript files: use ts-morph to move + update imports ---
  if (tsFiles.length > 0) {
    const { Project } = await import('ts-morph');

    const tsConfigPath = await findTsConfig(repoPath, absoluteOldDir + path.sep);

    // Use skipAddingFilesFromTsConfig to avoid eagerly loading ALL project files synchronously.
    // Then manually add files via addSourceFilesAtPaths which gives us the same result but
    // allows the event loop to tick between file parses, making timeouts actually work.
    const project = tsConfigPath
      ? new Project({
          tsConfigFilePath: tsConfigPath,
          skipAddingFilesFromTsConfig: true,
        })
      : new Project({
          compilerOptions: { allowJs: true, checkJs: false, noEmit: true },
        });

    // Add source files explicitly - this is needed for sf.move() to update import paths.
    // Using addSourceFilesAtPaths instead of letting ts-morph load from tsconfig because
    // the former parses files incrementally while the latter does it all synchronously.
    project.addSourceFilesAtPaths([
      path.join(repoPath, 'src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'),
      path.join(repoPath, 'lib/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'),
      path.join(repoPath, '*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'),
    ]);

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

  // --- Python files in a mixed tree: move each module via rope ---
  // Package-level move would also relocate TS files that ts-morph already handled,
  // so fall back to per-module rope moves.
  //
  // Important: never rope-move `__init__.py` first. Rope treats package __init__
  // as the package itself and can relocate sibling modules to unexpected paths
  // (e.g. pkg/shared/mixed/...). Move regular modules with rope, then place
  // __init__.py files via filesystem.
  const pyModules = pyFiles.filter((f) => path.basename(f) !== '__init__.py');
  const pyInits = pyFiles.filter((f) => path.basename(f) === '__init__.py');

  for (const absFile of pyModules) {
    const newPath = moveMap.get(absFile)!;
    const relOld = path.relative(repoPath, absFile).replace(/\\/g, '/');
    const relNew = path.relative(repoPath, newPath).replace(/\\/g, '/');

    // Skip if a prior rope operation already relocated this file
    if (!dryRun) {
      try {
        await fs.access(absFile);
      } catch {
        const alreadyAtDest = await fs.access(newPath).then(() => true).catch(() => false);
        if (alreadyAtDest) {
          filesMoved.push({ from: relOld, to: relNew });
          continue;
        }
      }
    }

    try {
      const result = await ropeMove({
        repoPath,
        oldPath: relOld,
        newPath: relNew,
        dryRun,
      });
      edits.push(
        ...result.edits.map((e) => ({
          filePath: e.filePath,
          line: e.line,
          old_text: e.old_text,
          new_text: e.new_text,
          confidence: 'rope' as const,
        })),
      );
      if (result.files_moved.length > 0) {
        // Only record moves that match this module (rope can report extras)
        const primary = result.files_moved.filter(
          (m) => m.from === relOld || m.to === relNew,
        );
        filesMoved.push(...(primary.length > 0 ? primary : result.files_moved));
      } else {
        filesMoved.push({ from: relOld, to: relNew });
      }
    } catch (e) {
      // If rope cannot refactor this module (e.g. broken package layout), fall back
      // to a plain filesystem move so the directory rename still completes.
      // Rope may have already relocated the file before failing — don't double-move.
      renameLogger.warn(
        { err: e, from: relOld, to: relNew },
        'rope move failed for Python file during directory rename; falling back to filesystem move',
      );
      filesMoved.push({ from: relOld, to: relNew });
      if (!dryRun) {
        let sourceExists = false;
        let destExists = false;
        try {
          await fs.access(absFile);
          sourceExists = true;
        } catch { /* already gone */ }
        try {
          await fs.access(newPath);
          destExists = true;
        } catch { /* not at dest yet */ }

        if (sourceExists && !destExists) {
          await fs.mkdir(path.dirname(newPath), { recursive: true });
          await fs.rename(absFile, newPath);
        } else if (!sourceExists && !destExists) {
          // Neither location has the file — rethrow so the caller sees a real failure
          throw e;
        }
        // else: already at dest (rope moved it) or both exist — leave as-is
      }
    }
  }

  // Place __init__.py files last via filesystem (content-only; package path already
  // rewritten by the module moves above when consumers import submodules).
  for (const absFile of pyInits) {
    const newPath = moveMap.get(absFile)!;
    const relOld = path.relative(repoPath, absFile).replace(/\\/g, '/');
    const relNew = path.relative(repoPath, newPath).replace(/\\/g, '/');
    filesMoved.push({ from: relOld, to: relNew });

    if (!dryRun) {
      try {
        await fs.access(absFile);
      } catch {
        continue; // already relocated with a prior package-level rope op
      }
      const destExists = await fs.access(newPath).then(() => true).catch(() => false);
      if (destExists) continue;
      await fs.mkdir(path.dirname(newPath), { recursive: true });
      await fs.rename(absFile, newPath);
    }
  }

  // --- Other non-TS/non-Python files: move via filesystem ---
  for (const absFile of otherFiles) {
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
