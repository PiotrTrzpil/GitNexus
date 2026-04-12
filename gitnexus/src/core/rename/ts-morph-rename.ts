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
import { renameLogger } from '../../util/logger.js';

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

/** Result when ts-morph successfully finds rename locations */
export interface TsMorphSuccess {
  status: 'success';
  edits: TsMorphEdit[];
}

/** Result when ts-morph cannot resolve the symbol — includes diagnostic reason */
export interface TsMorphNotFound {
  status: 'not_found';
  reason: string;
  details?: {
    file?: string;
    line?: number;
    column?: number;
    actualLineContent?: string;
    searchedFor?: string;
  };
}

export type TsMorphResult = TsMorphSuccess | TsMorphNotFound;

/** Walk up from startPath to find the nearest tsconfig.json within repoPath. */
export async function findTsConfig(repoPath: string, startPath: string): Promise<string | undefined> {
  let dir = path.dirname(startPath);
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
      renameLogger.error({ err, dir, candidate }, 'Error accessing tsconfig.json');
      throw err;
    }
  }
  return undefined;
}

/**
 * Find all rename locations for a symbol using ts-morph, and optionally apply them.
 *
 * @returns Result object with edits on success, or diagnostic info on failure.
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
}): Promise<TsMorphResult> {
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
      renameLogger.debug({ file: absoluteFile, oldName }, 'File not found for ts-morph rename');
      return {
        status: 'not_found',
        reason: `File not found: ${filePath}`,
        details: { file: filePath, searchedFor: oldName },
      };
    }
    renameLogger.error({ err, file: absoluteFile, oldName }, 'File access error in ts-morph rename');
    throw err; // permission error or other — propagate
  }

  // Lazy import — ts-morph is heavy, only load when needed
  const { Project, Node, SyntaxKind } = await import('ts-morph');

  const tsConfigPath = await findTsConfig(repoPath, absoluteFile);

  // Use skipAddingFilesFromTsConfig and skipFileDependencyResolution to prevent ts-morph
  // from eagerly loading ALL project files or following imports into node_modules.
  // The TypeScript language service used by findRenameLocations() will still find
  // cross-file references via its own lazy resolution.
  const project = tsConfigPath
    ? new Project({
        tsConfigFilePath: tsConfigPath,
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
      })
    : new Project({
        compilerOptions: { allowJs: true, checkJs: false, noEmit: true },
        skipFileDependencyResolution: true,
      });

  // Add the target file explicitly
  project.addSourceFileAtPath(absoluteFile);

  const sourceFile = project.getSourceFile(absoluteFile);
  if (!sourceFile) {
    return {
      status: 'not_found',
      reason: `ts-morph could not load source file: ${filePath}`,
      details: { file: filePath, searchedFor: oldName },
    };
  }

  // Locate the identifier on the target line
  const fullText = sourceFile.getFullText();
  const lines = fullText.split('\n');

  if (line > lines.length) {
    return {
      status: 'not_found',
      reason: `Line ${line} is out of range (file has ${lines.length} lines) — index may be stale, run 'gitnexus analyze'`,
      details: { file: filePath, line, searchedFor: oldName },
    };
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
  if (!identifier) {
    // Check if the name appears on the line as a whole word (not as a substring of another identifier)
    const wordBoundaryRegex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const nameOnLineAsWord = wordBoundaryRegex.test(targetLine);
    const nameAsSubstring = targetLine.includes(oldName) && !nameOnLineAsWord;

    let reason: string;
    if (nameOnLineAsWord) {
      reason = `Found '${oldName}' on line ${line}, but it's not a valid identifier (may be in a comment/string, or AST position mismatch)`;
    } else if (nameAsSubstring) {
      reason = `Symbol '${oldName}' not found at line ${line} — found similar name in '${targetLine.trim()}'. Index is likely stale, run 'gitnexus analyze'`;
    } else {
      reason = `Symbol '${oldName}' not found on line ${line} — index is stale, run 'gitnexus analyze'`;
    }
    return {
      status: 'not_found',
      reason,
      details: {
        file: filePath,
        line,
        column,
        actualLineContent: targetLine.trim(),
        searchedFor: oldName,
      },
    };
  }

  // Get rename locations from the language service
  const renameLocations = project.getLanguageService().findRenameLocations(identifier);
  if (!renameLocations || renameLocations.length === 0) {
    return {
      status: 'not_found',
      reason: `TypeScript language service found no rename locations for '${oldName}' — symbol may be in an unresolved module or have no references`,
      details: {
        file: filePath,
        line,
        column,
        actualLineContent: targetLine.trim(),
        searchedFor: oldName,
      },
    };
  }

  // --- Shorthand property expansion ---
  // When renaming an interface/type property that's used in shorthand object literal syntax
  // (e.g., `{ destBuilding }` which means `{ destBuilding: destBuilding }`), ts-morph's rename
  // only changes the property key, resulting in `{ newName }` — but there's no variable `newName`
  // in scope. We must expand these to explicit syntax BEFORE renaming:
  // `{ destBuilding }` → `{ destBuilding: destBuilding }` → after rename → `{ newName: destBuilding }`
  //
  // We track shorthand positions for edit preview (dry-run) and expand them for actual rename.
  interface ShorthandInfo {
    shorthand: import('ts-morph').ShorthandPropertyAssignment;
    filePath: string;
    start: number;
  }
  const shorthandsToExpand: ShorthandInfo[] = [];

  for (const loc of renameLocations) {
    const locSourceFile = loc.getSourceFile();
    const span = loc.getTextSpan();
    const start = span.getStart();
    const nodeAtPos = locSourceFile.getDescendantAtPos(start);
    if (!nodeAtPos) continue;

    // Walk up to find if this identifier is inside a ShorthandPropertyAssignment
    const shorthand = nodeAtPos.getFirstAncestorByKind(SyntaxKind.ShorthandPropertyAssignment);
    if (!shorthand) continue;

    // Check if the shorthand's name matches the identifier we're renaming
    // and the variable it references is different from the property being renamed
    const shorthandName = shorthand.getNameNode();
    if (shorthandName.getText() !== oldName) continue;

    // The shorthand references a local variable/parameter. If that variable is NOT part
    // of the rename (i.e., it's a different symbol), we need to expand the shorthand.
    // We detect this by checking if the shorthand's symbol differs from the identifier's symbol.
    const shorthandSymbol = shorthandName.getSymbol();
    const identifierSymbol = identifier.getSymbol();

    // If symbols differ, the shorthand must be expanded
    if (shorthandSymbol !== identifierSymbol) {
      shorthandsToExpand.push({
        shorthand,
        filePath: locSourceFile.getFilePath(),
        start,
      });
    }
  }

  // Build a set of shorthand positions for quick lookup during edit generation
  const shorthandPositions = new Set(
    shorthandsToExpand.map((s) => `${s.filePath}:${s.start}`),
  );

  // Build the edit list BEFORE any AST modifications (shorthand expansion)
  // This ensures edit previews reflect the original state accurately
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
      const errMsg = `ts-morph rename: span start ${start} is beyond end of file ${locSourceFile.getFilePath()} (${locFullText.length} chars)`;
      renameLogger.error({ start, file: locSourceFile.getFilePath(), fileLength: locFullText.length, oldName, newName }, 'Span beyond EOF');
      throw new Error(errMsg);
    }

    const lineText = locLines[locLineNum];
    const colInLine = start - charCount;

    if (colInLine < 0 || colInLine + span.getLength() > lineText.length) {
      const errMsg = `ts-morph rename: span [${colInLine}, ${colInLine + span.getLength()}] out of bounds for line ${locLineNum + 1} (length ${lineText.length}) in ${locSourceFile.getFilePath()}`;
      renameLogger.error({ colInLine, spanLength: span.getLength(), line: locLineNum + 1, lineLength: lineText.length, file: locSourceFile.getFilePath(), oldName, newName }, 'Span out of bounds');
      throw new Error(errMsg);
    }

    // Check if this is a shorthand property that needs expansion
    const isShorthand = shorthandPositions.has(`${locSourceFile.getFilePath()}:${start}`);
    let newLineText: string;

    if (isShorthand) {
      // For shorthand properties, expand to explicit syntax: `prop` → `newName: prop`
      newLineText =
        lineText.substring(0, colInLine) +
        `${newName}: ${oldName}` +
        lineText.substring(colInLine + span.getLength());
    } else {
      // Normal replacement
      newLineText =
        lineText.substring(0, colInLine) +
        newName +
        lineText.substring(colInLine + span.getLength());
    }

    edits.push({
      filePath: path.relative(repoPath, locSourceFile.getFilePath()),
      line: locLineNum + 1,
      old_text: lineText.trim(),
      new_text: newLineText.trim(),
      confidence: 'ts_morph',
    });
  }

  // Apply changes if not a dry run
  if (!dryRun) {
    // Step 1: Expand shorthand properties BEFORE applying the rename
    // This converts `{ foo }` to `{ foo: foo }` so ts-morph only renames the property key
    if (shorthandsToExpand.length > 0) {
      for (const { shorthand } of shorthandsToExpand) {
        const varName = shorthand.getName();
        shorthand.replaceWithText(`${varName}: ${varName}`);
      }
    }

    // Step 2: Apply the rename — ts-morph handles the expanded properties correctly
    identifier.rename(newName);
    await project.save();
  }

  return { status: 'success', edits };
}
