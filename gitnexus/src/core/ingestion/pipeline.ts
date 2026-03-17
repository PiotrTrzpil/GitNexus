import { createKnowledgeGraph } from '../graph/graph.js';
import { processStructure } from './structure-processor.js';
import { processParsing } from './parsing-processor.js';
import {
  processImports,
  processImportsFromExtracted,
  buildImportResolutionContext
} from './import-processor.js';
import { processCalls, processCallsFromExtracted, processRoutesFromExtracted } from './call-processor.js';
import { processHeritage, processHeritageFromExtracted } from './heritage-processor.js';
import { computeMRO } from './mro-processor.js';
import { processCommunities } from './community-processor.js';
import { processProcesses } from './process-processor.js';
import { createResolutionContext } from './resolution-context.js';
import { createASTCache } from './ast-cache.js';
import { PipelineProgress, PipelineResult } from '../../types/pipeline.js';
import { walkRepositoryPaths, readFileContents } from './filesystem-walker.js';
import { getLanguageFromFilename } from './utils.js';
import { isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { createWorkerPool, WorkerPool } from './workers/worker-pool.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyFiles, type FileHash } from './incremental.js';
import { loadFileHashes, saveFileHashes } from '../../storage/file-hashes.js';
import { loadParseCache, saveParseCache, type CachedFileResult } from '../../storage/parse-cache.js';
import { getStoragePaths } from '../../storage/repo-manager.js';

const isDev = process.env.NODE_ENV === 'development';

/** Max bytes of source content to load per parse chunk. Each chunk's source +
 *  parsed ASTs + extracted records + worker serialization overhead all live in
 *  memory simultaneously, so this must be conservative. 20MB source ≈ 200-400MB
 *  peak working memory per chunk after parse expansion. */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB

/** Max AST trees to keep in LRU cache */
const AST_CACHE_CAP = 50;

export interface PipelineOptions {
  /** Skip MRO, community detection, and process extraction for faster test runs. */
  skipGraphPhases?: boolean;
}

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  const ctx = createResolutionContext();
  const symbolTable = ctx.symbols;
  let astCache = createASTCache(AST_CACHE_CAP);

  const cleanup = () => {
    astCache.clear();
    ctx.clear();
  };

  try {
    // ── Phase 1: Scan paths only (no content read) ─────────────────────
    onProgress({
      phase: 'extracting',
      percent: 0,
      message: 'Scanning repository...',
    });

    const scannedFiles = await walkRepositoryPaths(repoPath, (current, total, filePath) => {
      const scanProgress = Math.round((current / total) * 15);
      onProgress({
        phase: 'extracting',
        percent: scanProgress,
        message: 'Scanning repository...',
        detail: filePath,
        stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
      });
    });

    const totalFiles = scannedFiles.length;

    onProgress({
      phase: 'extracting',
      percent: 15,
      message: 'Repository scanned successfully',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    // ── Phase 2: Structure (paths only — no content needed) ────────────
    onProgress({
      phase: 'structure',
      percent: 15,
      message: 'Analyzing project structure...',
      stats: { filesProcessed: 0, totalFiles, nodesCreated: graph.nodeCount },
    });

    const allPaths = scannedFiles.map(f => f.path);
    processStructure(graph, allPaths);

    onProgress({
      phase: 'structure',
      percent: 20,
      message: 'Project structure analyzed',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    // ── Phase 2.5: Incremental classification ─────────────────────────
    // Classify files as changed/unchanged using content hashing.
    // On first index all files are classified as changed (full parse).
    // On subsequent runs only changed files are re-parsed.
    const storagePaths = getStoragePaths(repoPath);
    let incrementalFilePaths: Set<string> | null = null;
    let incrementalUnchangedPaths: string[] = [];
    let currentFileHashes: FileHash[] | null = null;
    let parseCache = new Map<string, CachedFileResult>();
    try {
      const storedHashes = await loadFileHashes(storagePaths.storagePath);
      const classification = await classifyFiles(repoPath, scannedFiles, storedHashes);
      currentFileHashes = classification.currentHashes;
      if (classification.unchangedPaths.length > 0) {
        // There are unchanged files — run in incremental mode
        const parseSet = new Set(classification.changedPaths);
        incrementalFilePaths = parseSet;
        incrementalUnchangedPaths = classification.unchangedPaths;
        // Load parse cache for replaying unchanged file data
        parseCache = await loadParseCache(storagePaths.storagePath);
        if (isDev) {
          console.log(`⚡ Incremental: ${classification.changedPaths.length} changed, ${classification.unchangedPaths.length} cached`);
        }
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        // No stored hashes yet — fall back to full parse
      } else {
        throw err;
      }
    }

    // ── Phase 3+4: Chunked read + parse ────────────────────────────────
    // Group parseable files into byte-budget chunks so only ~20MB of source
    // is in memory at a time. Each chunk is: read → parse → extract → free.

    // Warn about files skipped due to unavailable parsers
    const skippedByLang = new Map<string, number>();
    for (const f of scannedFiles) {
      const lang = getLanguageFromFilename(f.path);
      if (lang && !isLanguageAvailable(lang)) {
        skippedByLang.set(lang, (skippedByLang.get(lang) || 0) + 1);
      }
    }
    for (const [lang, count] of skippedByLang) {
      console.warn(`Skipping ${count} ${lang} file(s) — ${lang} parser not available (native binding may not have built). Try: npm rebuild tree-sitter-${lang}`);
    }

    // Count all parseable files (before incremental filtering) for worker pool decision
    const allParseableScanned = scannedFiles.filter(f => {
      const lang = getLanguageFromFilename(f.path);
      return lang && isLanguageAvailable(lang);
    });

    // Don't spawn workers for tiny repos — overhead exceeds benefit.
    // Decision is based on ALL parseable files, not just changed ones.
    const MIN_FILES_FOR_WORKERS = 15;
    const MIN_BYTES_FOR_WORKERS = 512 * 1024;
    const totalBytes = allParseableScanned.reduce((s, f) => s + f.size, 0);

    // Create worker pool once, reuse across chunks
    let workerPool: WorkerPool | undefined;
    if (allParseableScanned.length >= MIN_FILES_FOR_WORKERS || totalBytes >= MIN_BYTES_FOR_WORKERS) {
      try {
        let workerUrl = new URL('./workers/parse-worker.js', import.meta.url);
        // When running under vitest, import.meta.url points to src/ where no .js exists.
        // Fall back to the compiled dist/ worker so the pool can spawn real worker threads.
        const thisDir = fileURLToPath(new URL('.', import.meta.url));
        if (!fs.existsSync(fileURLToPath(workerUrl))) {
          const distWorker = path.resolve(thisDir, '..', '..', '..', 'dist', 'core', 'ingestion', 'workers', 'parse-worker.js');
          if (fs.existsSync(distWorker)) {
            workerUrl = pathToFileURL(distWorker) as URL;
          }
        }
        workerPool = createWorkerPool(workerUrl);
      } catch (err) {
        if (isDev) console.warn('Worker pool creation failed, using sequential fallback:', (err as Error).message);
      }
    }

    // Incremental mode requires the worker path (which returns extracted data
    // for caching). If workers aren't available, disable incremental to ensure
    // a complete graph — the sequential fallback adds nodes directly without
    // returning cacheable data.
    if (!workerPool && incrementalFilePaths !== null) {
      if (isDev) {
        console.log('⚡ Incremental disabled: worker pool not available (sequential fallback cannot populate parse cache)');
      }
      incrementalFilePaths = null;
      incrementalUnchangedPaths = [];
    }

    // Apply incremental filter: skip unchanged files
    const parseableScanned = incrementalFilePaths !== null
      ? allParseableScanned.filter(f => incrementalFilePaths!.has(f.path))
      : allParseableScanned;

    const totalParseable = parseableScanned.length;

    if (totalParseable === 0) {
      onProgress({
        phase: 'parsing',
        percent: 82,
        message: 'No parseable files found — skipping parsing phase',
        stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: graph.nodeCount },
      });
    }

    // Build byte-budget chunks
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentBytes = 0;
    for (const file of parseableScanned) {
      if (currentChunk.length > 0 && currentBytes + file.size > CHUNK_BYTE_BUDGET) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentBytes = 0;
      }
      currentChunk.push(file.path);
      currentBytes += file.size;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const numChunks = chunks.length;

    if (isDev) {
      const totalMB = parseableScanned.reduce((s, f) => s + f.size, 0) / (1024 * 1024);
      console.log(`📂 Scan: ${totalFiles} paths, ${totalParseable} parseable (${totalMB.toFixed(0)}MB), ${numChunks} chunks @ ${CHUNK_BYTE_BUDGET / (1024 * 1024)}MB budget`);
    }

    onProgress({
      phase: 'parsing',
      percent: 20,
      message: `Parsing ${totalParseable} files in ${numChunks} chunk${numChunks !== 1 ? 's' : ''}...`,
      stats: { filesProcessed: 0, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
    });

    let filesParsedSoFar = 0;

    // AST cache sized for one chunk (sequential fallback uses it for import/call/heritage)
    const maxChunkFiles = chunks.reduce((max, c) => Math.max(max, c.length), 0);
    astCache = createASTCache(maxChunkFiles);

    // Build import resolution context once — suffix index, file lists, resolve cache.
    // Reused across all chunks to avoid rebuilding O(files × path_depth) structures.
    const importCtx = buildImportResolutionContext(allPaths);
    const allPathObjects = allPaths.map(p => ({ path: p }));

    // Single-pass: parse + resolve imports/calls/heritage per chunk.
    // Calls/heritage use the symbol table built so far (symbols from earlier chunks
    // are already registered). This trades ~5% cross-chunk resolution accuracy for
    // 200-400MB less memory — critical for Linux-kernel-scale repos.
    const sequentialChunkPaths: string[][] = [];

    // Accumulate per-file extraction data for the parse cache.
    // On a full run every parsed file is cached; on an incremental run only
    // the newly-parsed (changed) files are added — unchanged files keep their
    // existing cache entries.
    const newParseCache = new Map<string, CachedFileResult>();

    try {
      for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
        const chunkPaths = chunks[chunkIdx];

        // Read content for this chunk only
        const chunkContents = await readFileContents(repoPath, chunkPaths);
        const chunkFiles = chunkPaths
          .filter(p => chunkContents.has(p))
          .map(p => ({ path: p, content: chunkContents.get(p)! }));

        // Parse this chunk (workers or sequential fallback)
        const chunkWorkerData = await processParsing(
          graph, chunkFiles, symbolTable, astCache,
          (current, _total, filePath) => {
            const globalCurrent = filesParsedSoFar + current;
            const parsingProgress = 20 + ((globalCurrent / totalParseable) * 62);
            onProgress({
              phase: 'parsing',
              percent: Math.round(parsingProgress),
              message: `Parsing chunk ${chunkIdx + 1}/${numChunks}...`,
              detail: filePath,
              stats: { filesProcessed: globalCurrent, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
            });
          },
          workerPool,
        );

        const chunkBasePercent = 20 + ((filesParsedSoFar / totalParseable) * 62);

        if (chunkWorkerData) {
          // ── Cache: partition worker results by file ──────────────────
          // Each array in the worker result mixes records from all files
          // in this chunk.  Partition them into per-file CachedFileResult
          // entries so we can replay them on future incremental runs.
          const perFile = new Map<string, CachedFileResult>();
          const ensureEntry = (fp: string): CachedFileResult => {
            let entry = perFile.get(fp);
            if (!entry) {
              entry = { nodes: [], relationships: [], symbols: [], imports: [], calls: [], heritage: [], routes: [], constructorBindings: [] };
              perFile.set(fp, entry);
            }
            return entry;
          };
          const nodeFileMap = new Map<string, string>(); // nodeId → filePath
          for (const n of chunkWorkerData.nodes) {
            ensureEntry(n.properties.filePath).nodes.push(n);
            nodeFileMap.set(n.id, n.properties.filePath);
          }
          for (const r of chunkWorkerData.relationships) {
            // DEFINES: sourceId is a File node, targetId is the symbol → look up target
            // HAS_METHOD: sourceId is a Class node → look up source
            const fp = nodeFileMap.get(r.targetId) || nodeFileMap.get(r.sourceId);
            if (fp) ensureEntry(fp).relationships.push(r);
          }
          for (const s of chunkWorkerData.symbols) ensureEntry(s.filePath).symbols.push(s);
          for (const imp of chunkWorkerData.imports) ensureEntry(imp.filePath).imports.push(imp);
          for (const c of chunkWorkerData.calls) ensureEntry(c.filePath).calls.push(c);
          for (const h of chunkWorkerData.heritage) ensureEntry(h.filePath).heritage.push(h);
          for (const rt of (chunkWorkerData.routes ?? [])) ensureEntry(rt.filePath).routes.push(rt);
          for (const cb of chunkWorkerData.constructorBindings) ensureEntry(cb.filePath).constructorBindings.push(cb);
          for (const [fp, entry] of perFile) newParseCache.set(fp, entry);

          // Imports
          await processImportsFromExtracted(graph, allPathObjects, chunkWorkerData.imports, ctx, (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: Math.round(chunkBasePercent),
              message: `Resolving imports (chunk ${chunkIdx + 1}/${numChunks})...`,
              detail: `${current}/${total} files`,
              stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
            });
          }, repoPath, importCtx);
          // Calls + Heritage + Routes — resolve in parallel (no shared mutable state between them)
          // This is safe because each writes disjoint relationship types into idempotent id-keyed Maps,
          // and the single-threaded event loop prevents races between synchronous addRelationship calls.
          await Promise.all([
            processCallsFromExtracted(
              graph,
              chunkWorkerData.calls,
              ctx,
              (current, total) => {
                onProgress({
                  phase: 'parsing',
                  percent: Math.round(chunkBasePercent),
                  message: `Resolving calls (chunk ${chunkIdx + 1}/${numChunks})...`,
                  detail: `${current}/${total} files`,
                  stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
                });
              },
              chunkWorkerData.constructorBindings,
            ),
            processHeritageFromExtracted(
              graph,
              chunkWorkerData.heritage,
              ctx,
              (current, total) => {
                onProgress({
                  phase: 'parsing',
                  percent: Math.round(chunkBasePercent),
                  message: `Resolving heritage (chunk ${chunkIdx + 1}/${numChunks})...`,
                  detail: `${current}/${total} records`,
                  stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
                });
              },
            ),
            processRoutesFromExtracted(
              graph,
              chunkWorkerData.routes ?? [],
              ctx,
              (current, total) => {
                onProgress({
                  phase: 'parsing',
                  percent: Math.round(chunkBasePercent),
                  message: `Resolving routes (chunk ${chunkIdx + 1}/${numChunks})...`,
                  detail: `${current}/${total} routes`,
                  stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
                });
              },
            ),
          ]);
        } else {
          await processImports(graph, chunkFiles, astCache, ctx, undefined, repoPath, allPaths);
          sequentialChunkPaths.push(chunkPaths);
        }

        filesParsedSoFar += chunkFiles.length;

        // Clear AST cache between chunks to free memory
        astCache.clear();
        // chunkContents + chunkFiles + chunkWorkerData go out of scope → GC reclaims
      }
    } finally {
      await workerPool?.terminate();
    }

    // Sequential fallback chunks: re-read source for call/heritage resolution
    for (const chunkPaths of sequentialChunkPaths) {
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter(p => chunkContents.has(p))
        .map(p => ({ path: p, content: chunkContents.get(p)! }));
      astCache = createASTCache(chunkFiles.length);
      const rubyHeritage = await processCalls(graph, chunkFiles, astCache, ctx);
      await processHeritage(graph, chunkFiles, astCache, ctx);
      if (rubyHeritage.length > 0) {
        await processHeritageFromExtracted(graph, rubyHeritage, ctx);
      }
      astCache.clear();
    }

    // ── Replay cached data for unchanged files ────────────────────────────
    // On incremental runs, unchanged files were skipped during parsing above.
    // Replay their cached extraction data so the graph is complete before
    // community detection and process extraction run.
    if (incrementalUnchangedPaths.length > 0 && parseCache.size > 0) {
      const cachedImports: CachedFileResult['imports'] = [];
      const cachedCalls: CachedFileResult['calls'] = [];
      const cachedHeritage: CachedFileResult['heritage'] = [];
      const cachedRoutes: CachedFileResult['routes'] = [];
      const cachedConstructorBindings: CachedFileResult['constructorBindings'] = [];

      let cachedFileCount = 0;
      for (const filePath of incrementalUnchangedPaths) {
        const cached = parseCache.get(filePath);
        if (!cached) continue;

        cachedFileCount++;

        // Re-add nodes, relationships, and symbols to the fresh graph
        for (const node of cached.nodes) {
          graph.addNode({ id: node.id, label: node.label as any, properties: node.properties as any });
        }
        for (const rel of cached.relationships) {
          graph.addRelationship(rel);
        }
        for (const sym of cached.symbols) {
          symbolTable.add(sym.filePath, sym.name, sym.nodeId, sym.type, {
            parameterCount: sym.parameterCount,
            returnType: sym.returnType,
            ownerId: sym.ownerId,
          });
        }

        // Accumulate extracted data for resolution
        cachedImports.push(...cached.imports);
        cachedCalls.push(...cached.calls);
        cachedHeritage.push(...cached.heritage);
        cachedRoutes.push(...cached.routes);
        cachedConstructorBindings.push(...cached.constructorBindings);

        // Carry forward unchanged file cache entries
        newParseCache.set(filePath, cached);
      }

      if (cachedFileCount > 0) {
        if (isDev) {
          console.log(`📦 Cache replay: ${cachedFileCount} files restored from parse cache`);
        }

        // Resolve imports/calls/heritage/routes for cached files — same as for parsed chunks
        if (cachedImports.length > 0) {
          await processImportsFromExtracted(graph, allPathObjects, cachedImports, ctx, undefined, repoPath, importCtx);
        }
        await Promise.all([
          cachedCalls.length > 0
            ? processCallsFromExtracted(graph, cachedCalls, ctx, undefined, cachedConstructorBindings)
            : Promise.resolve(),
          cachedHeritage.length > 0
            ? processHeritageFromExtracted(graph, cachedHeritage, ctx)
            : Promise.resolve(),
          cachedRoutes.length > 0
            ? processRoutesFromExtracted(graph, cachedRoutes, ctx)
            : Promise.resolve(),
        ]);
      }
    }

    // Log resolution cache stats
    if (isDev) {
      const rcStats = ctx.getStats();
      const total = rcStats.cacheHits + rcStats.cacheMisses;
      const hitRate = total > 0 ? ((rcStats.cacheHits / total) * 100).toFixed(1) : '0';
      console.log(`🔍 Resolution cache: ${rcStats.cacheHits} hits, ${rcStats.cacheMisses} misses (${hitRate}% hit rate)`);
    }

    // Free import resolution context — suffix index + resolve cache no longer needed
    // (allPathObjects and importCtx hold ~94MB+ for large repos)
    allPathObjects.length = 0;
    importCtx.resolveCache.clear();
    (importCtx as any).suffixIndex = null;
    (importCtx as any).normalizedFileList = null;

    let communityResult: Awaited<ReturnType<typeof processCommunities>> | undefined;
    let processResult: Awaited<ReturnType<typeof processProcesses>> | undefined;

    if (!options?.skipGraphPhases) {
      // ── Phase 4.5: Method Resolution Order ──────────────────────────────
      onProgress({
        phase: 'parsing',
        percent: 81,
        message: 'Computing method resolution order...',
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });

      const mroResult = computeMRO(graph);
      if (isDev && mroResult.entries.length > 0) {
        console.log(`🔀 MRO: ${mroResult.entries.length} classes analyzed, ${mroResult.ambiguityCount} ambiguities found, ${mroResult.overrideEdges} OVERRIDES edges`);
      }

      // ── Phase 5: Communities ───────────────────────────────────────────
      onProgress({
        phase: 'communities',
        percent: 82,
        message: 'Detecting code communities...',
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });

      communityResult = await processCommunities(graph, (message, progress) => {
        const communityProgress = 82 + (progress * 0.10);
        onProgress({
          phase: 'communities',
          percent: Math.round(communityProgress),
          message,
          stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
        });
      });

      if (isDev) {
        console.log(`🏘️ Community detection: ${communityResult.stats.totalCommunities} communities found (modularity: ${communityResult.stats.modularity.toFixed(3)})`);
      }

      communityResult.communities.forEach(comm => {
        graph.addNode({
          id: comm.id,
          label: 'Community' as const,
          properties: {
            name: comm.label,
            filePath: '',
            heuristicLabel: comm.heuristicLabel,
            cohesion: comm.cohesion,
            symbolCount: comm.symbolCount,
          }
        });
      });

      communityResult.memberships.forEach(membership => {
        graph.addRelationship({
          id: `${membership.nodeId}_member_of_${membership.communityId}`,
          type: 'MEMBER_OF',
          sourceId: membership.nodeId,
          targetId: membership.communityId,
          confidence: 1.0,
          reason: 'leiden-algorithm',
        });
      });

      // ── Phase 6: Processes ─────────────────────────────────────────────
      onProgress({
        phase: 'processes',
        percent: 94,
        message: 'Detecting execution flows...',
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });

      let symbolCount = 0;
      graph.forEachNode(n => { if (n.label !== 'File') symbolCount++; });
      const dynamicMaxProcesses = Math.max(20, Math.min(300, Math.round(symbolCount / 10)));

      processResult = await processProcesses(
        graph,
        communityResult.memberships,
        (message, progress) => {
          const processProgress = 94 + (progress * 0.05);
          onProgress({
            phase: 'processes',
            percent: Math.round(processProgress),
            message,
            stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
          });
        },
        { maxProcesses: dynamicMaxProcesses, minSteps: 3 }
      );

      if (isDev) {
        console.log(`🔄 Process detection: ${processResult.stats.totalProcesses} processes found (${processResult.stats.crossCommunityCount} cross-community)`);
      }

      processResult.processes.forEach(proc => {
        graph.addNode({
          id: proc.id,
          label: 'Process' as const,
          properties: {
            name: proc.label,
            filePath: '',
            heuristicLabel: proc.heuristicLabel,
            processType: proc.processType,
            stepCount: proc.stepCount,
            communities: proc.communities,
            entryPointId: proc.entryPointId,
            terminalId: proc.terminalId,
          }
        });
      });

      processResult.steps.forEach(step => {
        graph.addRelationship({
          id: `${step.nodeId}_step_${step.step}_${step.processId}`,
          type: 'STEP_IN_PROCESS',
          sourceId: step.nodeId,
          targetId: step.processId,
          confidence: 1.0,
          reason: 'trace-detection',
          step: step.step,
        });
      });
    }

    onProgress({
      phase: 'complete',
      percent: 100,
      message: communityResult && processResult
        ? `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes detected.`
        : 'Graph complete! (graph phases skipped)',
      stats: {
        filesProcessed: totalFiles,
        totalFiles,
        nodesCreated: graph.nodeCount
      },
    });

    astCache.clear();

    // Persist file hashes and parse cache for incremental indexing on the next run
    if (currentFileHashes) {
      try {
        await saveFileHashes(storagePaths.storagePath, currentFileHashes);
      } catch (err) {
        console.warn('Failed to save file hashes (next run will do a full index):', (err as Error).message);
      }
    }
    if (newParseCache.size > 0) {
      try {
        await saveParseCache(storagePaths.storagePath, newParseCache);
      } catch (err) {
        console.warn('Failed to save parse cache (next run will re-parse all files):', (err as Error).message);
      }
    }

    return { graph, repoPath, totalFileCount: totalFiles, communityResult, processResult };
  } catch (error) {
    cleanup();
    throw error;
  }
};
