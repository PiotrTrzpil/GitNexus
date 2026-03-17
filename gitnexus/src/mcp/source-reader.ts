/**
 * Source Reader — disk-fresh source code with line numbers and context
 *
 * Shared utility for MCP tools that need to display symbol source code.
 * Reads from disk (not graph n.content) for freshness.
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Format source lines with right-aligned line numbers.
 * Output: "  42 | func foo() {"
 */
function formatWithLineNumbers(lines: string[], startLine: number): string {
  const lastLineNum = startLine + lines.length - 1;
  const width = String(lastLineNum).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)} | ${line}`)
    .join('\n');
}

/**
 * Read a file from disk and return line-numbered source for a range with context.
 *
 * @param repoPath  - Absolute path to the repository root
 * @param filePath  - Relative file path within the repo
 * @param startLine - 1-indexed start line of the symbol
 * @param endLine   - 1-indexed end line of the symbol
 * @param contextLines - Number of surrounding context lines (default 3)
 * @returns Formatted source with line numbers, or null if file not found
 */
export async function readSourceWithContext(
  repoPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
  contextLines = 3,
): Promise<{ source: string; firstLine: number; lastLine: number } | null> {
  const absPath = path.resolve(repoPath, filePath);

  // Path traversal guard
  if (!absPath.startsWith(path.resolve(repoPath))) return null;

  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }

  const allLines = content.split('\n');
  const firstLine = Math.max(1, startLine - contextLines);
  const lastLine = Math.min(allLines.length, endLine + contextLines);

  const slice = allLines.slice(firstLine - 1, lastLine);
  const source = formatWithLineNumbers(slice, firstLine);

  return { source, firstLine, lastLine };
}
