/**
 * Analyze Command
 *
 * Indexes a repository and stores the knowledge graph in .gitnexus/
 */

import path from 'path';
import { execFileSync } from 'child_process';
import v8 from 'v8';
import cliProgress from 'cli-progress';
import { runPipelineFromRepo } from '../core/ingestion/pipeline.js';
import { getLastIgnoreStats } from '../core/ingestion/filesystem-walker.js';
import { initLbug, loadGraphToLbug, getLbugStats, executeQuery, executeWithReusedStatement, closeLbug, createFTSIndex, loadCachedEmbeddings } from '../core/lbug/lbug-adapter.js';
import { tryAcquireLock, releaseLock } from '../util/lockfile.js';
// Embedding imports are lazy (dynamic import) so onnxruntime-node is never
// loaded when embeddings are not requested. This avoids crashes on Node
// versions whose ABI is not yet supported by the native binary (#89).
// disposeEmbedder intentionally not called — ONNX Runtime segfaults on cleanup (see #38)
import { getStoragePaths, saveMeta, loadMeta, addToGitignore, registerRepo, getGlobalRegistryPath, cleanupOldKuzuFiles } from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot } from '../storage/git.js';
import { generateAIContextFiles } from './ai-context.js';
import { generateSkillFiles, type GeneratedSkillInfo } from './skill-gen.js';
import fs from 'fs/promises';
import { VERSION } from '../config/version.js';


const HEAP_MB = 8192;
const HEAP_FLAG = `--max-old-space-size=${HEAP_MB}`;

/** Re-exec the process with an 8GB heap if we're currently below that. */
function ensureHeap(): boolean {
  const nodeOpts = process.env.NODE_OPTIONS || '';
  if (nodeOpts.includes('--max-old-space-size')) return false;

  const v8Heap = v8.getHeapStatistics().heap_size_limit;
  if (v8Heap >= HEAP_MB * 1024 * 1024 * 0.9) return false;

  try {
    execFileSync(process.execPath, [HEAP_FLAG, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: `${nodeOpts} ${HEAP_FLAG}`.trim() },
    });
  } catch (e: any) {
    process.exitCode = e.status ?? 1;
  }
  return true;
}

export interface AnalyzeOptions {
  force?: boolean;
  embeddings?: boolean;
  skills?: boolean;
  verbose?: boolean;
  cfg?: boolean;
}

/** Threshold: auto-skip embeddings for repos with more nodes than this */
const EMBEDDING_NODE_LIMIT = 200_000;

const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  lbug: 'Loading into LadybugDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

export const analyzeCommand = async (
  inputPath?: string,
  options?: AnalyzeOptions
) => {
  if (ensureHeap()) return;

  if (options?.verbose) {
    process.env.GITNEXUS_VERBOSE = '1';
  }

  if (options?.cfg === false) {
    process.env.GITNEXUS_NO_CFG = '1';
  }

  console.log('\n  GitNexus Analyzer\n');

  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      console.log('  Not inside a git repository\n');
      process.exitCode = 1;
      return;
    }
    repoPath = gitRoot;
  }

  if (!isGitRepo(repoPath)) {
    console.log('  Not a git repository\n');
    process.exitCode = 1;
    return;
  }

  const { storagePath, lbugPath } = getStoragePaths(repoPath);

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  // If kuzu existed but lbug doesn't, we're doing a migration re-index — say so.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    console.log('  Migrating from KuzuDB to LadybugDB — rebuilding index...\n');
  }

  const currentCommit = getCurrentCommit(repoPath);
  const existingMeta = await loadMeta(storagePath);

  // Detect whether the existing index needs a full rebuild (not just incremental)
  let needsFullRebuild = !!options?.force;

  if (existingMeta && !options?.force && !options?.skills && existingMeta.lastCommit === currentCommit) {
    // Verify index integrity before skipping rebuild
    const dbExists = await fs.access(lbugPath).then(() => true, () => false);
    const versionMatch = existingMeta.version === VERSION;
    const statsPresent = existingMeta.stats && existingMeta.stats.nodes != null && existingMeta.stats.edges != null;

    if (!dbExists) {
      console.log('  Database missing — rebuilding index...\n');
      needsFullRebuild = true;
    } else if (!versionMatch) {
      console.log(`  Index was built with ${existingMeta.version || 'unknown version'} (current: ${VERSION}) — rebuilding...\n`);
      needsFullRebuild = true;
    } else if (!statsPresent) {
      console.log('  Index metadata incomplete — rebuilding...\n');
      needsFullRebuild = true;
    } else {
      // Verify FTS indexes are actually present in the DB before skipping rebuild.
      // Open read-only to avoid lock conflicts with the MCP server.
      let ftsIntact = false;
      try {
        const lbugMod = await import('@ladybugdb/core');
        const testDb = new lbugMod.default.Database(lbugPath, 0, false, true);
        const testConn = new lbugMod.default.Connection(testDb);
        try {
          await testConn.query('LOAD EXTENSION fts');
          await testConn.query(
            `CALL QUERY_FTS_INDEX('File', 'file_fts', 'test', conjunctive := false) RETURN node LIMIT 1`,
          );
          ftsIntact = true;
        } finally {
          try { await testConn.close(); } catch {}
          try { await testDb.close(); } catch {}
        }
      } catch {
        // FTS index missing, broken, or DB locked
      }

      if (!ftsIntact) {
        console.log('  FTS search indexes missing — rebuilding...\n');
        needsFullRebuild = true;
      } else {
        console.log('  Already up to date\n');
        return;
      }
    }
  }

  if (process.env.GITNEXUS_NO_GITIGNORE) {
    console.log('  GITNEXUS_NO_GITIGNORE is set — skipping .gitignore (still reading .gitnexusignore)\n');
  }

  // Single progress bar for entire pipeline
  const bar = new cliProgress.SingleBar({
    format: '  {bar} {percentage}% | {phase}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    barGlue: '',
    autopadding: true,
    clearOnComplete: false,
    stopOnComplete: false,
  }, cliProgress.Presets.shades_grey);

  bar.start(100, 0, { phase: 'Initializing...' });

  // Rebuild lock path — set when we start LadybugDB phase, cleaned up on exit
  let rebuildLockPath: string | null = null;

  // Graceful SIGINT handling — clean up resources and exit
  let aborted = false;
  const sigintHandler = async () => {
    if (aborted) process.exit(1); // Second Ctrl-C: force exit
    aborted = true;
    bar.stop();
    console.log('\n  Interrupted — cleaning up...');
    // Remove rebuild lock if we created it
    if (rebuildLockPath) {
      await releaseLock(rebuildLockPath);
    }
    closeLbug().catch(() => {}).finally(() => process.exit(130));
  };
  process.on('SIGINT', sigintHandler);

  // Route all console output through bar.log() so the bar doesn't stamp itself
  // multiple times when other code writes to stdout/stderr mid-render.
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const barLog = (...args: any[]) => {
    // Clear the bar line, print the message, then let the next bar.update redraw
    process.stdout.write('\x1b[2K\r');
    origLog(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  console.log = barLog;
  console.warn = barLog;
  console.error = barLog;

  // Track elapsed time per phase — both updateBar and the interval use the
  // same format so they don't flicker against each other.
  let lastPhaseLabel = 'Initializing...';
  let phaseStart = Date.now();

  /** Update bar with phase label + elapsed seconds (shown after 3s). */
  const updateBar = (value: number, phaseLabel: string) => {
    if (phaseLabel !== lastPhaseLabel) { lastPhaseLabel = phaseLabel; phaseStart = Date.now(); }
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    const display = elapsed >= 3 ? `${phaseLabel} (${elapsed}s)` : phaseLabel;
    bar.update(value, { phase: display });
  };

  // Tick elapsed seconds for phases with infrequent progress callbacks
  // (e.g. CSV streaming, FTS indexing). Uses the same display format as
  // updateBar so there's no flickering.
  const elapsedTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    if (elapsed >= 3) {
      bar.update({ phase: `${lastPhaseLabel} (${elapsed}s)` });
    }
  }, 1000);

  const t0Global = Date.now();

  // ── Cache embeddings from existing index before rebuild ────────────
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: Array<{ nodeId: string; embedding: number[] }> = [];

  if (options?.embeddings && existingMeta && !needsFullRebuild) {
    try {
      updateBar(0, 'Caching embeddings...');
      await initLbug(lbugPath);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      await closeLbug();
    } catch {
      try { await closeLbug(); } catch {}
    }
  }

  // When a full rebuild is needed (--force or integrity check failure),
  // delete stored file hashes so the incremental classifier treats every
  // file as changed (full re-parse).
  if (needsFullRebuild) {
    const { fileHashPath } = getStoragePaths(repoPath);
    try {
      await fs.rm(fileHashPath, { force: true });
    } catch (err: any) {
      console.warn(`[analyze] Failed to remove file hashes for re-index: ${err?.message}`);
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ─────────────────────────────────
  const pipelineResult = await runPipelineFromRepo(repoPath, (progress) => {
    const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase;
    const scaled = Math.round(progress.percent * 0.6);
    updateBar(scaled, phaseLabel);
  });

  // Sanity check: a parseable repo should produce code symbols, not just File nodes.
  // If parsing silently dropped every symbol (e.g. native binding crash, language-group
  // catch swallowed errors) we'd otherwise only notice via "FTS missing" errors much later.
  let parseableFileCount = 0;
  let symbolCount = 0;
  const PARSEABLE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|c|h|cc|cpp|hpp|cs|go|rs|kt|kts|php|rb|swift)$/i;
  const SYMBOL_LABELS = new Set([
    'Function', 'Class', 'Interface', 'Method', 'Constructor', 'Property',
    'Struct', 'Enum', 'Trait', 'Impl', 'TypeAlias', 'Module', 'Namespace',
    'Macro', 'Typedef', 'Union', 'Const', 'Static', 'Record', 'Delegate', 'Annotation', 'Template',
  ]);
  pipelineResult.graph.forEachNode((n) => {
    if (n.label === 'File' && PARSEABLE_EXT.test(n.properties?.filePath || '')) parseableFileCount++;
    if (SYMBOL_LABELS.has(n.label as string)) symbolCount++;
  });
  if (parseableFileCount >= 10 && symbolCount === 0) {
    throw new Error(
      `Parsing extracted 0 symbols from ${parseableFileCount} parseable source file(s). ` +
      `This indicates a parser failure (native binding, query compilation, or worker crash). ` +
      `Run with NODE_OPTIONS='--stack-trace-limit=50' and check the warnings above.`
    );
  }

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────────
  updateBar(60, 'Loading into LadybugDB...');

  // Create rebuild lock BEFORE closing/deleting — signals MCP server to close its connections.
  // This prevents native crashes when MCP tries to use deleted file handles.
  rebuildLockPath = `${lbugPath}.rebuild`;
  const lockAcquired = await tryAcquireLock(rebuildLockPath, { staleMs: 60_000 });
  if (!lockAcquired) {
    // Another analyze is running — this shouldn't happen often
    console.warn('  Warning: Another analyze process may be running. Proceeding anyway.');
  }

  // Give MCP server time to notice the lock and close connections.
  // The MCP server runs a rebuild-lock watcher every 100ms that proactively
  // closes all DB connections when it detects this lock. 500ms gives it
  // 5 polling cycles — enough time to close connections and avoid native crash.
  await new Promise(resolve => setTimeout(resolve, 500));

  await closeLbug();
  const lbugFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`];
  for (const f of lbugFiles) {
    try { await fs.rm(f, { recursive: true, force: true }); } catch {}
  }

  const t0Lbug = Date.now();
  await initLbug(lbugPath);
  let lbugMsgCount = 0;
  const lbugResult = await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
    lbugMsgCount++;
    const progress = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
    updateBar(progress, msg);
  });
  const lbugTime = ((Date.now() - t0Lbug) / 1000).toFixed(1);
  const lbugWarnings = lbugResult.warnings;

  // Post-load sanity check: verify symbols actually made it into LadybugDB.
  // The pre-load check (line ~298) validates the in-memory graph, but IGNORE_ERRORS=true
  // in COPY can silently drop rows. This catches silent data loss.
  if (symbolCount > 0) {
    const postLoadStats = await getLbugStats();
    // Expected: files + folders + symbols. Allow 10% tolerance for deduplication/edge cases.
    const expectedNodes = parseableFileCount + symbolCount;
    const minExpected = Math.floor(expectedNodes * 0.90);
    if (postLoadStats.nodes < minExpected) {
      throw new Error(
        `LadybugDB data loss detected: parsed ${expectedNodes} nodes (${parseableFileCount} files + ${symbolCount} symbols) ` +
        `but only ${postLoadStats.nodes} made it into the database. ` +
        `This indicates silent COPY failures. Check CSV encoding or LadybugDB compatibility.`
      );
    }
  }

  // Persist file hashes NOW — after LBUG loading succeeded. If saved earlier
  // (in the pipeline) and LBUG crashes, the next run skips parsing because it
  // thinks all files are unchanged.
  if (pipelineResult.currentFileHashes) {
    try {
      const { saveFileHashes } = await import('../storage/file-hashes.js');
      await saveFileHashes(storagePath, pipelineResult.currentFileHashes);
    } catch {
      // Non-fatal — worst case next run is a full re-parse
    }
  }

  // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
  updateBar(85, 'Creating search indexes...');

  const t0Fts = Date.now();
  await createFTSIndex('File', 'file_fts', ['name', 'content']);
  await createFTSIndex('Function', 'function_fts', ['name', 'content']);
  await createFTSIndex('Class', 'class_fts', ['name', 'content']);
  await createFTSIndex('Method', 'method_fts', ['name', 'content']);
  await createFTSIndex('Interface', 'interface_fts', ['name', 'content']);
  const ftsTime = ((Date.now() - t0Fts) / 1000).toFixed(1);

  // Flush FTS indexes to the main DB file immediately. Without this,
  // FTS data lives only in the WAL — if the process crashes later
  // (e.g. ONNX Runtime's native cleanup during exit), the MCP server
  // will auto-delete the corrupted WAL and lose the indexes.
  try { await executeQuery('CHECKPOINT'); } catch {}

  // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
  if (cachedEmbeddings.length > 0) {
    updateBar(88, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
    const EMBED_BATCH = 200;
    for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
      const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);
      const paramsList = batch.map(e => ({ nodeId: e.nodeId, embedding: e.embedding }));
      try {
        await executeWithReusedStatement(
          `CREATE (e:CodeEmbedding {nodeId: $nodeId, embedding: $embedding})`,
          paramsList,
        );
      } catch { /* some may fail if node was removed, that's fine */ }
    }
  }

  // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
  const stats = await getLbugStats();
  let embeddingTime = '0.0';
  let embeddingSkipped = true;
  let embeddingSkipReason = 'off (use --embeddings to enable)';

  if (options?.embeddings) {
    if (stats.nodes > EMBEDDING_NODE_LIMIT) {
      embeddingSkipReason = `skipped (${stats.nodes.toLocaleString()} nodes > ${EMBEDDING_NODE_LIMIT.toLocaleString()} limit)`;
    } else {
      embeddingSkipped = false;
    }
  }

  if (!embeddingSkipped) {
    updateBar(90, 'Loading embedding model...');
    const t0Emb = Date.now();
    const { runEmbeddingPipeline } = await import('../core/embeddings/embedding-pipeline.js');
    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      (progress) => {
        const scaled = 90 + Math.round((progress.percent / 100) * 8);
        const label = progress.phase === 'loading-model' ? 'Loading embedding model...' : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
        updateBar(scaled, label);
      },
      {},
      cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
    );
    embeddingTime = ((Date.now() - t0Emb) / 1000).toFixed(1);

    // Flush embeddings to main DB file before the crash-prone exit
    try { await executeQuery('CHECKPOINT'); } catch {}
  }

  // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
  updateBar(98, 'Saving metadata...');

  // Count embeddings in the index (cached + newly generated)
  let embeddingCount = 0;
  try {
    const embResult = await executeQuery(`MATCH (e:CodeEmbedding) RETURN count(e) AS cnt`);
    embeddingCount = embResult?.[0]?.cnt ?? 0;
  } catch { /* table may not exist if embeddings never ran */ }

  const meta = {
    repoPath,
    lastCommit: currentCommit,
    indexedAt: new Date().toISOString(),
    version: VERSION,
    stats: {
      files: pipelineResult.totalFileCount,
      nodes: stats.nodes,
      edges: stats.edges,
      communities: pipelineResult.communityResult?.stats.totalCommunities,
      processes: pipelineResult.processResult?.stats.totalProcesses,
      embeddings: embeddingCount,
    },
  };
  await saveMeta(storagePath, meta);
  await registerRepo(repoPath, meta);
  await addToGitignore(repoPath);

  const projectName = path.basename(repoPath);
  let aggregatedClusterCount = 0;
  if (pipelineResult.communityResult?.communities) {
    const groups = new Map<string, number>();
    for (const c of pipelineResult.communityResult.communities) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      groups.set(label, (groups.get(label) || 0) + c.symbolCount);
    }
    aggregatedClusterCount = Array.from(groups.values()).filter(count => count >= 5).length;
  }

  let generatedSkills: GeneratedSkillInfo[] = [];
  if (options?.skills && pipelineResult.communityResult) {
    updateBar(99, 'Generating skill files...');
    const skillResult = await generateSkillFiles(repoPath, projectName, pipelineResult);
    generatedSkills = skillResult.skills;
  }

  const aiContext = await generateAIContextFiles(repoPath, storagePath, projectName, {
    files: pipelineResult.totalFileCount,
    nodes: stats.nodes,
    edges: stats.edges,
    communities: pipelineResult.communityResult?.stats.totalCommunities,
    clusters: aggregatedClusterCount,
    processes: pipelineResult.processResult?.stats.totalProcesses,
  }, generatedSkills);

  await closeLbug();

  // Remove rebuild lock — MCP server can now reopen connections
  if (rebuildLockPath) {
    await releaseLock(rebuildLockPath);
  }

  // Remove any WAL file left after close. ONNX Runtime's native atexit hooks
  // can crash the process, and if a WAL exists at that point the crash corrupts
  // it — making the DB unopenable until the WAL is manually deleted.
  try { await fs.rm(`${lbugPath}.wal`, { force: true }); } catch {}

  const totalTime = ((Date.now() - t0Global) / 1000).toFixed(1);

  clearInterval(elapsedTimer);
  process.removeListener('SIGINT', sigintHandler);

  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;

  bar.update(100, { phase: 'Done' });
  bar.stop();

  // ── Summary ───────────────────────────────────────────────────────
  const embeddingsCached = cachedEmbeddings.length > 0;
  console.log(`\n  Repository indexed successfully (${totalTime}s)${embeddingsCached ? ` [${cachedEmbeddings.length} embeddings cached]` : ''}\n`);
  console.log(`  ${stats.nodes.toLocaleString()} nodes | ${stats.edges.toLocaleString()} edges | ${pipelineResult.communityResult?.stats.totalCommunities || 0} clusters | ${pipelineResult.processResult?.stats.totalProcesses || 0} flows`);
  console.log(`  LadybugDB ${lbugTime}s | FTS ${ftsTime}s | Embeddings ${embeddingSkipped ? embeddingSkipReason : embeddingTime + 's'}`);
  const ignoreStats = getLastIgnoreStats();
  if (ignoreStats) {
    const total = ignoreStats.userPatterns + ignoreStats.hardcodedDirs + ignoreStats.hardcodedFiles;
    if (total > 0) {
      console.log(`  Ignored: ${total.toLocaleString()} (user: ${ignoreStats.userPatterns} | default dirs: ${ignoreStats.hardcodedDirs} | default files: ${ignoreStats.hardcodedFiles}) — use \`gitnexus why-ignored <path>\` to inspect`);
    }
  }
  console.log(`  ${repoPath}`);

  if (aiContext.files.length > 0) {
    console.log(`  Context: ${aiContext.files.join(', ')}`);
  }

  // Show a quiet summary if some edge types needed fallback insertion
  if (lbugWarnings.length > 0) {
    const totalFallback = lbugWarnings.reduce((sum, w) => {
      const m = w.match(/\((\d+) edges\)/);
      return sum + (m ? parseInt(m[1]) : 0);
    }, 0);
    console.log(`  Note: ${totalFallback} edges across ${lbugWarnings.length} types inserted via fallback (schema will be updated in next release)`);
  }

  try {
    await fs.access(getGlobalRegistryPath());
  } catch {
    console.log('\n  Tip: Run `gitnexus setup` to configure MCP for your editor.');
  }

  console.log('');

  // LadybugDB's native module holds open handles that prevent Node from exiting.
  // ONNX Runtime also registers native atexit hooks that crash via C++ mutex
  // errors on macOS/Linux (#38, #40). All data is already checkpointed and the
  // DB is closed, so forcefully terminate without waiting for cleanup.
  process.exit(0);
};
