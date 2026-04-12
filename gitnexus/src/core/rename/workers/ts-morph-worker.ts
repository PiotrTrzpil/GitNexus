/**
 * Worker thread for ts-morph rename operations.
 *
 * ts-morph uses the TypeScript compiler which has synchronous, CPU-bound operations
 * that block the event loop. Running in a worker thread allows the main thread to
 * enforce hard timeouts via worker.terminate().
 */

import { parentPort } from 'node:worker_threads';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

interface RenameRequest {
  type: 'rename';
  repoPath: string;
  filePath: string;
  line: number;
  column?: number;
  oldName: string;
  newName: string;
  dryRun: boolean;
}

interface RenameEdit {
  filePath: string;
  line: number;
  old_text: string;
  new_text: string;
  confidence: 'ts_morph';
}

interface SuccessResult {
  type: 'success';
  edits: RenameEdit[];
}

interface NotFoundResult {
  type: 'not_found';
  reason: string;
  details?: {
    file?: string;
    line?: number;
    column?: number;
    actualLineContent?: string;
    searchedFor?: string;
  };
}

interface ErrorResult {
  type: 'error';
  message: string;
}

type WorkerResult = SuccessResult | NotFoundResult | ErrorResult;

/** Walk up from startPath to find the nearest tsconfig.json within repoPath. */
async function findTsConfig(repoPath: string, startPath: string): Promise<string | undefined> {
  let dir = path.dirname(startPath);
  while (dir.startsWith(repoPath)) {
    const candidate = path.join(dir, 'tsconfig.json');
    try {
      await fs.access(candidate);
      return candidate;
    } catch (err: unknown) {
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

async function handleRename(req: RenameRequest): Promise<WorkerResult> {
  const { repoPath, filePath, line, column, oldName, newName, dryRun } = req;
  const absoluteFile = path.resolve(repoPath, filePath);

  // Validate inputs
  if (line < 1) return { type: 'error', message: `Invalid line number: ${line} (must be >= 1)` };
  if (!oldName) return { type: 'error', message: 'oldName is required' };
  if (!newName) return { type: 'error', message: 'newName is required' };

  // Check file existence
  try {
    await fs.access(absoluteFile);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        type: 'not_found',
        reason: `File not found: ${filePath}`,
        details: { file: filePath, searchedFor: oldName },
      };
    }
    throw err;
  }

  // Import ts-morph (heavy, do it here in the worker)
  const { Project, Node, SyntaxKind } = await import('ts-morph');

  const tsConfigPath = await findTsConfig(repoPath, absoluteFile);

  // Use skipAddingFilesFromTsConfig to control which files we load.
  // We then manually add source files from the project (excluding node_modules)
  // to enable cross-file renames without loading thousands of dependency files.
  const project = tsConfigPath
    ? new Project({
        tsConfigFilePath: tsConfigPath,
        skipAddingFilesFromTsConfig: true,
      })
    : new Project({
        compilerOptions: { allowJs: true, checkJs: false, noEmit: true },
      });

  // Add project source files (excluding node_modules) for cross-file rename support
  project.addSourceFilesAtPaths([
    path.join(repoPath, 'src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'),
    path.join(repoPath, 'lib/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'),
    path.join(repoPath, 'app/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'),
    path.join(repoPath, '*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'),
  ]);

  // Ensure the target file is loaded (in case it's outside the standard paths)
  if (!project.getSourceFile(absoluteFile)) {
    project.addSourceFileAtPath(absoluteFile);
  }

  const sourceFile = project.getSourceFile(absoluteFile);
  if (!sourceFile) {
    return {
      type: 'not_found',
      reason: `ts-morph could not load source file: ${filePath}`,
      details: { file: filePath, searchedFor: oldName },
    };
  }

  // Locate the identifier on the target line
  const fullText = sourceFile.getFullText();
  const lines = fullText.split('\n');

  if (line > lines.length) {
    return {
      type: 'not_found',
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

  // Locate the identifier
  let identifier: import('ts-morph').Identifier | undefined;

  if (column != null && column > 0) {
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
      type: 'not_found',
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
      type: 'not_found',
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

  // Handle shorthand property expansion
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

    const shorthand = nodeAtPos.getFirstAncestorByKind(SyntaxKind.ShorthandPropertyAssignment);
    if (!shorthand) continue;

    const shorthandName = shorthand.getNameNode();
    if (shorthandName.getText() !== oldName) continue;

    const shorthandSymbol = shorthandName.getSymbol();
    const identifierSymbol = identifier.getSymbol();

    if (shorthandSymbol !== identifierSymbol) {
      shorthandsToExpand.push({
        shorthand,
        filePath: locSourceFile.getFilePath(),
        start,
      });
    }
  }

  const shorthandPositions = new Set(
    shorthandsToExpand.map((s) => `${s.filePath}:${s.start}`),
  );

  // Build the edit list
  const edits: RenameEdit[] = [];

  for (const loc of renameLocations) {
    const locSourceFile = loc.getSourceFile();
    const locFullText = locSourceFile.getFullText();
    const locLines = locFullText.split('\n');
    const span = loc.getTextSpan();
    const start = span.getStart();

    let charCount = 0;
    let locLineNum = -1;
    for (let i = 0; i < locLines.length; i++) {
      if (charCount + locLines[i].length >= start) {
        locLineNum = i;
        break;
      }
      charCount += locLines[i].length + 1;
    }

    if (locLineNum === -1) {
      return { type: 'error', message: `Span start ${start} is beyond end of file ${locSourceFile.getFilePath()}` };
    }

    const lineText = locLines[locLineNum];
    const colInLine = start - charCount;

    if (colInLine < 0 || colInLine + span.getLength() > lineText.length) {
      return { type: 'error', message: `Span out of bounds for line ${locLineNum + 1} in ${locSourceFile.getFilePath()}` };
    }

    const isShorthand = shorthandPositions.has(`${locSourceFile.getFilePath()}:${start}`);
    let newLineText: string;

    if (isShorthand) {
      newLineText =
        lineText.substring(0, colInLine) +
        `${newName}: ${oldName}` +
        lineText.substring(colInLine + span.getLength());
    } else {
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
    if (shorthandsToExpand.length > 0) {
      for (const { shorthand } of shorthandsToExpand) {
        const varName = shorthand.getName();
        shorthand.replaceWithText(`${varName}: ${varName}`);
      }
    }
    identifier.rename(newName);
    await project.save();
  }

  return { type: 'success', edits };
}

// Worker message handler
parentPort?.on('message', async (msg: RenameRequest) => {
  try {
    const result = await handleRename(msg);
    parentPort?.postMessage(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ type: 'error', message } as ErrorResult);
  }
});
