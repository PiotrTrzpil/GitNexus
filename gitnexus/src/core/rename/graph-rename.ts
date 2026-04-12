/**
 * Graph + text search fallback rename.
 * Used when ts-morph (TS/JS) and rope (Python) cannot resolve the symbol.
 * Finds references via the knowledge graph (high confidence) and ripgrep
 * text search (lower confidence).
 *
 * Error contract (mirrors ts-morph-rename / rope-rename):
 * - Never returns `null` — always produces a result (possibly with 0 edits).
 * - Collects warnings instead of throwing on individual file failures.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { renameLogger } from '../../util/logger.js';

const execFileAsync = promisify(execFile);

// Resolve full path to ripgrep at module load — avoids PATH inheritance issues in test environments
let rgPath = 'rg';
try {
  rgPath = execFileSync('which', ['rg'], { encoding: 'utf-8' }).trim() || 'rg';
} catch {
  // Fall back to bare 'rg' and let the caller handle ENOENT
}

export interface GraphRenameEdit {
  filePath: string;
  line: number;
  old_text: string;
  new_text: string;
  confidence: 'graph' | 'text_search';
}

export interface GraphRenameRef {
  filePath?: string;
}

export interface GraphRenameResult {
  edits: GraphRenameEdit[];
  graphEdits: number;
  textSearchEdits: number;
  warnings: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect rename edits from the knowledge graph + ripgrep text search.
 *
 * @param repoPath   Absolute path to the repo root
 * @param defFile    Relative path to the definition file (from graph)
 * @param incomingRefs  Files that reference the symbol (from graph)
 * @param oldName    Current symbol name
 * @param newName    New symbol name
 * @param dryRun     If false, write the changes to disk
 */
export async function graphTextSearchRename(opts: {
  repoPath: string;
  defFile: string | undefined;
  incomingRefs: GraphRenameRef[];
  oldName: string;
  newName: string;
  dryRun: boolean;
  /** Skip ripgrep text search — only use graph edges. Default: true (text_search must be explicit). */
  includeTextSearch?: boolean;
}): Promise<GraphRenameResult> {
  const { repoPath, defFile, incomingRefs, oldName, newName, dryRun, includeTextSearch = false } = opts;

  const changes = new Map<string, { filePath: string; edits: GraphRenameEdit[] }>();
  const warnings: string[] = [];
  let graphEdits = 0;
  let textSearchEdits = 0;

  const nameRegex = () => new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g');

  const addEdit = (filePath: string, line: number, oldText: string, newText: string, confidence: 'graph' | 'text_search') => {
    if (!changes.has(filePath)) {
      changes.set(filePath, { filePath, edits: [] });
    }
    const fileEdits = changes.get(filePath)!.edits;
    // Deduplicate: skip if we already have an edit for this exact line
    if (fileEdits.some(e => e.line === line)) return;
    fileEdits.push({ filePath, line, old_text: oldText, new_text: newText, confidence });
  };

  /** Resolve a relative path within the repo, blocking path traversal. */
  const safePath = (relPath: string): string => {
    const full = path.resolve(repoPath, relPath);
    if (!full.startsWith(repoPath + path.sep) && full !== repoPath) {
      throw new Error(`Path traversal blocked: ${relPath}`);
    }
    return full;
  };

  /** Scan all lines of a file for the symbol name. */
  const scanFile = async (filePath: string, confidence: 'graph' | 'text_search') => {
    try {
      const content = await fs.readFile(safePath(filePath), 'utf-8');
      const lines = content.split('\n');
      const regex = nameRegex();
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          regex.lastIndex = 0;
          addEdit(filePath, i + 1, lines[i].trim(), lines[i].replace(nameRegex(), newName).trim(), confidence);
          if (confidence === 'graph') graphEdits++;
          else textSearchEdits++;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      renameLogger.warn({ err: e, file: filePath, oldName }, 'Could not read file for rename scan');
      warnings.push(`Could not read file ${filePath}: ${msg}`);
    }
  };

  // 1. The definition file — scan all lines
  if (defFile) {
    await scanFile(defFile, 'graph');
  }

  // 2. All incoming refs from graph (callers, importers, etc.)
  for (const ref of incomingRefs) {
    if (!ref.filePath) continue;
    await scanFile(ref.filePath, 'graph');
  }

  // 3. Text search for refs the graph might have missed (opt-in only)
  if (includeTextSearch) {
    const graphFiles = new Set([defFile, ...incomingRefs.map(r => r.filePath)].filter(Boolean));

    try {
      const rgArgs = [
        '-l',
        '--type-add', 'code:*.{ts,tsx,js,jsx,py,go,rs,java,c,h,cpp,cc,cxx,hpp,hxx,hh,cs,php,swift}',
        '-t', 'code',
        `\\b${oldName}\\b`,
        '.',
      ];
      const { stdout: output } = await execFileAsync(rgPath, rgArgs, { cwd: repoPath, encoding: 'utf-8', timeout: 5000 });
      const files = output.trim().split('\n').filter(f => f.length > 0);

      for (const file of files) {
        const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
        if (graphFiles.has(normalizedFile)) continue; // already covered by graph
        await scanFile(normalizedFile, 'text_search');
      }
    } catch (e) {
      // rg exit code 1 = no matches (not an error)
      const isNoMatch = e instanceof Error && 'code' in e && (e as any).code === 1;
      if (!isNoMatch) {
        const msg = e instanceof Error ? e.message : String(e);
        renameLogger.warn({ err: e, oldName, repoPath }, 'Text search (rg) failed');
        warnings.push(`Text search (rg) failed: ${msg}`);
      }
    }
  }

  // 4. Flatten edits
  const allEdits: GraphRenameEdit[] = [];
  for (const { edits } of changes.values()) {
    allEdits.push(...edits);
  }

  // 5. Apply if not dry run
  if (!dryRun) {
    const applyFailures: string[] = [];
    for (const [filePath, { edits }] of changes) {
      try {
        const fullPath = safePath(filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        const regex = nameRegex();
        for (const edit of edits) {
          const lineIdx = edit.line - 1;
          if (lineIdx >= 0 && lineIdx < lines.length) {
            lines[lineIdx] = lines[lineIdx].replace(regex, newName);
          }
        }
        await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        renameLogger.error({ err: e, file: filePath, oldName, newName }, 'Failed to apply rename edits');
        applyFailures.push(`${filePath}: ${msg}`);
      }
    }
    if (applyFailures.length > 0) {
      warnings.push(`Failed to apply edits: ${applyFailures.join('; ')}`);
    }
  }

  return { edits: allEdits, graphEdits, textSearchEdits, warnings };
}
