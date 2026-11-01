/**
 * Worker thread: computes the import rewrites for moving TS/JS files with ts-morph.
 *
 * ts-morph drives the TypeScript compiler, whose work is synchronous and CPU
 * bound. Running it here lets the parent enforce a hard timeout by terminating
 * the thread. Nothing in this file writes to disk.
 */

import { parentPort } from 'node:worker_threads';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { MoveEdit, MoveRequest, MoveResponse, MoveWrite } from './protocol.js';

const SOURCE_GLOB = '*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}';

/** Walk up from `startDir` to the nearest tsconfig.json at or below `repoPath`. */
async function findTsConfig(repoPath: string, startDir: string): Promise<string | undefined> {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'tsconfig.json');
    try {
      await fs.access(candidate);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (dir === repoPath) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir || !parent.startsWith(repoPath)) return undefined;
    dir = parent;
  }
}

async function planMove(req: MoveRequest): Promise<MoveResponse> {
  const { repoPath, from, to, kind, tsFiles } = req;
  const { Project } = await import('ts-morph');

  const startDir = kind === 'directory' ? from : path.dirname(from);
  const tsConfigPath = await findTsConfig(repoPath, startDir);
  const project = tsConfigPath
    ? new Project({ tsConfigFilePath: tsConfigPath })
    : new Project({ compilerOptions: { allowJs: true, checkJs: false, noEmit: true } });

  // The tsconfig `include` often omits tests/scripts that still import the moved
  // module, so also load every source file in the repo (minus dependencies).
  project.addSourceFilesAtPaths([
    path.join(repoPath, '**', SOURCE_GLOB),
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/.git/**',
  ]);
  for (const file of tsFiles) {
    if (!project.getSourceFile(file)) project.addSourceFileAtPath(file);
  }

  const snapshots = new Map<string, string>();
  for (const sf of project.getSourceFiles()) snapshots.set(sf.getFilePath(), sf.getFullText());

  // old absolute path -> new absolute path, for the files that move
  const moved = new Map<string, string>();
  for (const file of tsFiles) {
    moved.set(file, kind === 'file' ? to : path.join(to, path.relative(from, file)));
  }
  for (const [oldAbs, newAbs] of moved) {
    const sf = project.getSourceFile(oldAbs);
    if (!sf) return { type: 'error', message: `ts-morph could not load ${oldAbs}` };
    sf.move(newAbs);
  }
  const originalByNewPath = new Map<string, string>();
  for (const [oldAbs, newAbs] of moved) originalByNewPath.set(newAbs, snapshots.get(oldAbs) ?? '');

  const edits: MoveEdit[] = [];
  const writes: MoveWrite[] = [];
  for (const sf of project.getSourceFiles()) {
    const current = sf.getFilePath() as string;
    const isMoved = originalByNewPath.has(current);
    const original = isMoved ? originalByNewPath.get(current) : snapshots.get(current);
    const text = sf.getFullText();
    if (original === undefined) continue;
    if (isMoved || original !== text) writes.push({ path: current, text });
    if (original === text) continue;

    const oldLines = original.split('\n');
    const newLines = text.split('\n');
    const reportPath = path.relative(repoPath, current).split(path.sep).join('/');
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      if (oldLines[i] === newLines[i]) continue;
      edits.push({
        filePath: reportPath,
        line: i + 1,
        old_text: (oldLines[i] ?? '').trim(),
        new_text: (newLines[i] ?? '').trim(),
        confidence: 'ts_morph',
      });
    }
  }
  return { type: 'success', edits, writes };
}

parentPort?.on('message', async (req: MoveRequest) => {
  try {
    parentPort?.postMessage(await planMove(req));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ type: 'error', message } satisfies MoveResponse);
  }
});
