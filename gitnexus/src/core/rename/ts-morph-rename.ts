/**
 * ts-morph-powered rename for TypeScript/JavaScript files.
 * Uses the TypeScript language service for scope-aware, semantically correct renames.
 *
 * Error contract:
 * - Returns `null` when the symbol cannot be located (clean signal to fall back).
 * - Throws on infrastructure errors (IO, parse, bad tsconfig) — caller must handle.
 */

import * as path from 'path';
import * as fs from 'fs/promises';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

export function isTypeScriptFile(filePath: string): boolean {
  return TS_EXTENSIONS.has(path.extname(filePath));
}

export interface TsMorphEdit {
  filePath: string;
  line: number;
  old_text: string;
  new_text: string;
  confidence: 'ts_morph';
}

/** Walk up from sourceFile to find the nearest tsconfig.json within repoPath. */
async function findTsConfig(repoPath: string, sourceFile: string): Promise<string | undefined> {
  let dir = path.dirname(sourceFile);
  while (dir.startsWith(repoPath)) {
    const candidate = path.join(dir, 'tsconfig.json');
    try {
      await fs.access(candidate);
      return candidate;
    } catch (err: unknown) {
      // Only swallow "file not found" — rethrow permission errors, etc.
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
        continue;
      }
      throw err;
    }
  }
  return undefined;
}

/**
 * Find all rename locations for a symbol using ts-morph, and optionally apply them.
 *
 * @returns Array of edits, or `null` if the symbol could not be resolved.
 * @throws On IO errors, broken tsconfig, or ts-morph failures.
 */
export async function tsMorphRename(opts: {
  repoPath: string;
  filePath: string;    // relative to repoPath
  line: number;        // 1-based
  column?: number;     // 0-based column of the name node; skip regex when provided and > 0
  oldName: string;
  newName: string;
  dryRun: boolean;
}): Promise<TsMorphEdit[] | null> {
  const { repoPath, filePath, line, column, oldName, newName, dryRun } = opts;
  const absoluteFile = path.resolve(repoPath, filePath);

  // Validate inputs
  if (line < 1) throw new Error(`Invalid line number: ${line} (must be >= 1)`);
  if (!oldName) throw new Error('oldName is required');
  if (!newName) throw new Error('newName is required');

  // Check file existence before loading ts-morph (fast fail)
  try {
    await fs.access(absoluteFile);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null; // file doesn't exist — signal to fall back
    }
    throw err; // permission error or other — propagate
  }

  // Lazy import — ts-morph is heavy, only load when needed
  const { Project, Node, SyntaxKind } = await import('ts-morph');

  const tsConfigPath = await findTsConfig(repoPath, absoluteFile);

  const project = tsConfigPath
    ? new Project({ tsConfigFilePath: tsConfigPath })
    : new Project({
        compilerOptions: { allowJs: true, checkJs: false, noEmit: true },
      });

  // Ensure the target file is part of the project
  if (!project.getSourceFile(absoluteFile)) {
    if (!tsConfigPath) {
      project.addSourceFilesAtPaths([
        path.join(repoPath, 'src/**/*.{ts,tsx,js,jsx}'),
        path.join(repoPath, 'lib/**/*.{ts,tsx,js,jsx}'),
        path.join(repoPath, '*.{ts,tsx,js,jsx}'),
      ]);
    }
    if (!project.getSourceFile(absoluteFile)) {
      project.addSourceFileAtPath(absoluteFile); // throws if file missing (already checked above)
    }
  }

  const sourceFile = project.getSourceFile(absoluteFile);
  if (!sourceFile) return null;

  // Locate the identifier on the target line
  const fullText = sourceFile.getFullText();
  const lines = fullText.split('\n');

  if (line > lines.length) {
    return null; // line number out of range
  }

  const targetLine = lines[line - 1];
  const nameRegex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');

  // Calculate the byte offset of the start of the target line
  let lineStartPos = 0;
  for (let i = 0; i < line - 1; i++) {
    lineStartPos += lines[i].length + 1; // +1 for newline
  }

  // Locate the identifier: use the provided column for a direct position lookup,
  // or fall back to iterating regex matches (the first may land in a comment/string).
  let identifier: import('ts-morph').Identifier | undefined;

  if (column != null && column > 0) {
    // Fast path: jump directly to the exact character position
    const pos = lineStartPos + column;
    const nodeAtPos = sourceFile.getDescendantAtPos(pos);
    if (nodeAtPos) {
      const candidate = Node.isIdentifier(nodeAtPos)
        ? nodeAtPos
        : nodeAtPos.getFirstAncestorByKind(SyntaxKind.Identifier);
      if (candidate && candidate.getText() === oldName) {
        identifier = candidate;
      }
    }
  } else {
    // Regex fallback: iterate matches on the line until an Identifier AST node is found
    let match: RegExpExecArray | null;
    while ((match = nameRegex.exec(targetLine)) !== null) {
      const pos = lineStartPos + match.index;
      const nodeAtPos = sourceFile.getDescendantAtPos(pos);
      if (!nodeAtPos) continue;

      const candidate = Node.isIdentifier(nodeAtPos)
        ? nodeAtPos
        : nodeAtPos.getFirstAncestorByKind(SyntaxKind.Identifier);
      if (candidate && candidate.getText() === oldName) {
        identifier = candidate;
        break;
      }
    }
  }
  if (!identifier) return null;

  // Get rename locations from the language service
  const renameLocations = project.getLanguageService().findRenameLocations(identifier);
  if (!renameLocations || renameLocations.length === 0) return null;

  // Build the edit list
  const edits: TsMorphEdit[] = [];

  for (const loc of renameLocations) {
    const locSourceFile = loc.getSourceFile();
    const locFullText = locSourceFile.getFullText();
    const locLines = locFullText.split('\n');
    const span = loc.getTextSpan();
    const start = span.getStart();

    // Find line number for this span
    let charCount = 0;
    let locLineNum = -1;
    for (let i = 0; i < locLines.length; i++) {
      if (charCount + locLines[i].length >= start) {
        locLineNum = i;
        break;
      }
      charCount += locLines[i].length + 1; // +1 for newline
    }

    if (locLineNum === -1) {
      throw new Error(
        `ts-morph rename: span start ${start} is beyond end of file ` +
        `${locSourceFile.getFilePath()} (${locFullText.length} chars)`,
      );
    }

    const lineText = locLines[locLineNum];
    const colInLine = start - charCount;

    if (colInLine < 0 || colInLine + span.getLength() > lineText.length) {
      throw new Error(
        `ts-morph rename: span [${colInLine}, ${colInLine + span.getLength()}] out of bounds ` +
        `for line ${locLineNum + 1} (length ${lineText.length}) in ${locSourceFile.getFilePath()}`,
      );
    }

    const newLineText =
      lineText.substring(0, colInLine) +
      newName +
      lineText.substring(colInLine + span.getLength());

    edits.push({
      filePath: path.relative(repoPath, locSourceFile.getFilePath()),
      line: locLineNum + 1,
      old_text: lineText.trim(),
      new_text: newLineText.trim(),
      confidence: 'ts_morph',
    });
  }

  // Apply the rename if not a dry run — errors propagate to caller
  if (!dryRun) {
    identifier.rename(newName);
    await project.save();
  }

  return edits;
}
