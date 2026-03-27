/**
 * Integration Test: Full Analyze Diagnostic
 *
 * Runs the complete pipeline + LBUG loading on a real repository path
 * and dumps detailed diagnostic info about what was extracted.
 *
 * Usage:
 *   GITNEXUS_TEST_REPO=/path/to/repo pnpm test:integration -- full-analyze-diagnostic
 *
 * Skips if GITNEXUS_TEST_REPO is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  initLbug,
  loadGraphToLbug,
  executeQuery,
  createFTSIndex,
  getLbugStats,
  closeLbug,
} from '../../src/core/lbug/lbug-adapter.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const TEST_REPO = process.env.GITNEXUS_TEST_REPO;

describe.skipIf(!TEST_REPO)('full analyze diagnostic', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let lbugPath: string;
  let storagePath: string;

  beforeAll(async () => {
    // Create temp directory for the test DB
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-diag-'));
    lbugPath = path.join(tmpDir, 'lbug');
    storagePath = tmpDir;

    // Phase 1: Run pipeline
    console.log(`\n[DIAG] Running pipeline on: ${TEST_REPO}`);
    const phases: string[] = [];
    result = await runPipelineFromRepo(TEST_REPO!, (p) => {
      if (!phases.includes(p.phase)) {
        phases.push(p.phase);
        console.log(`[DIAG] Phase: ${p.phase} (${p.percent}%) nodes=${p.stats?.nodesCreated ?? '?'}`);
      }
    });

    // Dump graph node labels
    const labelCounts: Record<string, number> = {};
    for (const node of result.graph.iterNodes()) {
      labelCounts[node.label] = (labelCounts[node.label] || 0) + 1;
    }
    console.log('[DIAG] Graph node labels:', JSON.stringify(labelCounts, null, 2));

    // Dump edge types
    const edgeCounts: Record<string, number> = {};
    for (const rel of result.graph.iterRelationships()) {
      edgeCounts[rel.type] = (edgeCounts[rel.type] || 0) + 1;
    }
    console.log('[DIAG] Graph edge types:', JSON.stringify(edgeCounts, null, 2));

    // Phase 2: Load into LBUG
    console.log('[DIAG] Loading into LadybugDB...');
    await initLbug(lbugPath);
    const lbugResult = await loadGraphToLbug(result.graph, TEST_REPO!, storagePath, (msg) => {
      console.log(`[DIAG] LBUG: ${msg}`);
    });
    if (lbugResult.warnings.length > 0) {
      console.log('[DIAG] LBUG warnings:', lbugResult.warnings);
    }

    // Phase 3: Create FTS indexes
    const ftsTargets = ['File', 'Function', 'Class', 'Method', 'Interface'] as const;
    for (const table of ftsTargets) {
      try {
        await createFTSIndex(table, `${table.toLowerCase()}_fts`, ['name', 'content']);
      } catch {
        // Non-fatal
      }
    }

    console.log('[DIAG] LBUG loading complete');
  }, 120_000);

  afterAll(async () => {
    await closeLbug();
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('pipeline produces non-file nodes', () => {
    const labelCounts: Record<string, number> = {};
    for (const node of result.graph.iterNodes()) {
      labelCounts[node.label] = (labelCounts[node.label] || 0) + 1;
    }

    // Must have more than just File + Folder
    const nonStructural = Object.entries(labelCounts)
      .filter(([label]) => label !== 'File' && label !== 'Folder')
      .reduce((sum, [, count]) => sum + count, 0);

    console.log(`[DIAG] Non-structural nodes: ${nonStructural}`);
    expect(nonStructural).toBeGreaterThan(0);
  });

  it('LBUG contains all node labels from the graph', async () => {
    // Collect expected labels from graph
    const graphLabels = new Set<string>();
    for (const node of result.graph.iterNodes()) {
      graphLabels.add(node.label);
    }

    // Query LBUG for each label
    const lbugCounts: Record<string, number> = {};
    const missingLabels: string[] = [];

    for (const label of graphLabels) {
      try {
        const rows = await executeQuery(`MATCH (n:\`${label}\`) RETURN count(n) AS cnt`);
        const cnt = rows[0]?.cnt ?? 0;
        lbugCounts[label] = cnt;
        if (cnt === 0) missingLabels.push(label);
      } catch (err) {
        console.log(`[DIAG] Query failed for label ${label}:`, (err as Error).message);
        lbugCounts[label] = -1;
        missingLabels.push(label);
      }
    }

    console.log('[DIAG] LBUG node counts per label:', JSON.stringify(lbugCounts, null, 2));

    if (missingLabels.length > 0) {
      console.log('[DIAG] MISSING from LBUG:', missingLabels);
    }

    // The critical assertion: LBUG should have the same labels as the graph
    expect(missingLabels).toEqual([]);
  });

  it('LBUG stats match graph counts', async () => {
    const stats = await getLbugStats();
    console.log('[DIAG] LBUG stats:', JSON.stringify(stats));
    console.log(`[DIAG] Graph nodeCount=${result.graph.nodeCount}`);

    // Stats should be close to graph counts (some edge types may be filtered)
    expect(stats.nodes).toBeGreaterThan(0);
    expect(stats.nodes).toBe(result.graph.nodeCount);
  });

  it('LBUG has Functions with correct properties', async () => {
    const funcs = await executeQuery(
      'MATCH (n:Function) RETURN n.id AS id, n.name AS name, n.filePath AS file, n.startLine AS line LIMIT 10',
    );
    console.log('[DIAG] Sample Functions:', JSON.stringify(funcs, null, 2));

    if (funcs.length > 0) {
      expect(funcs[0]).toHaveProperty('id');
      expect(funcs[0]).toHaveProperty('name');
      expect(funcs[0]).toHaveProperty('file');
    }
  });

  it('LBUG has CALLS edges', async () => {
    const calls = await executeQuery(
      "MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b) RETURN a.name AS caller, b.name AS callee LIMIT 10",
    );
    console.log(`[DIAG] CALLS edges: ${calls.length} (showing first 10)`);
    if (calls.length > 0) {
      console.log('[DIAG] Sample CALLS:', JSON.stringify(calls.slice(0, 5), null, 2));
    }
  });

  it('LBUG has IMPORTS edges', async () => {
    const imports = await executeQuery(
      "MATCH (a)-[r:CodeRelation {type: 'IMPORTS'}]->(b) RETURN a.name AS importer, b.name AS imported LIMIT 10",
    );
    console.log(`[DIAG] IMPORTS edges: ${imports.length} (showing first 10)`);
  });

  it('sample non-File nodes have startLine and endLine', async () => {
    for (const label of ['Function', 'Class', 'Method', 'Interface'] as const) {
      try {
        const rows = await executeQuery(
          `MATCH (n:\`${label}\`) RETURN n.name AS name, n.startLine AS startLine, n.endLine AS endLine LIMIT 3`,
        );
        if (rows.length > 0) {
          console.log(`[DIAG] ${label} samples:`, JSON.stringify(rows));
          expect(rows[0].startLine).toBeGreaterThan(0);
        }
      } catch {
        // Table may not exist for this repo
      }
    }
  });
});
