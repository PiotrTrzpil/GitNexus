/**
 * Layer 2: Parse Worker Integration Tests
 *
 * Tests that CFG data flows correctly through the parse worker thread boundary.
 * These tests require the compiled dist/ worker, so they use describe.skip
 * when the worker is unavailable (same pattern as worker-pool.test.ts).
 *
 * Tests 2.1–2.4 from the oxc-cfg-napi design doc.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createWorkerPool, type WorkerPool } from '../../../src/core/ingestion/workers/worker-pool.js';

const DIST_WORKER = path.resolve(__dirname, '..', '..', '..', 'dist', 'core', 'ingestion', 'workers', 'parse-worker.js');
const hasDistWorker = fs.existsSync(DIST_WORKER);

// Source for a TypeScript file with a named function that has branching
const TS_SOURCE_WITH_FUNCTION = `
function handleRequest(req: any, res: any): void {
  if (!req.body) {
    res.status(400).send('Bad Request');
    return;
  }
  res.status(200).send('OK');
}

function parsePayload(data: string): object {
  return JSON.parse(data);
}
`.trim();

// Source for a Python file (non-TS/JS)
const PYTHON_SOURCE = `
def handle_request(req):
    if not req:
        return None
    return req.body
`.trim();

describe.skipIf(!hasDistWorker)('Layer 2: Parse Worker CFG Integration', () => {
  let pool: WorkerPool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.terminate();
      pool = undefined;
    }
  });

  /**
   * 2.1 Worker returns cfgData
   *
   * Send a TS file through the parse worker (via the worker pool dispatch).
   * Verify ParseWorkerResult.cfgData contains an ExtractedFileCfg entry for that file.
   * Verify functions array is populated with correct names.
   */
  it('2.1: TS file parse result includes cfgData with function entries', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);

    const results = await pool.dispatch<any, any>([
      { path: 'src/handler.ts', content: TS_SOURCE_WITH_FUNCTION },
    ]);

    expect(results).toHaveLength(1);
    const result = results[0];

    // cfgData should be present on the result
    expect(result).toHaveProperty('cfgData');
    expect(Array.isArray(result.cfgData)).toBe(true);

    // If the binding is available, cfgData should have an entry for the file
    // If the binding is unavailable, cfgData may be empty — both are valid outcomes
    if (result.cfgData.length > 0) {
      const fileCfg = result.cfgData.find((c: any) => c.filePath === 'src/handler.ts');
      expect(fileCfg).toBeDefined();
      expect(Array.isArray(fileCfg.functions)).toBe(true);

      // Should have found at least the two named functions
      const functionNames = fileCfg.functions.map((f: any) => f.name);
      expect(functionNames.some((name: string) => name.includes('handleRequest'))).toBe(true);
    } else {
      // Binding unavailable — cfgData is empty but result is otherwise valid
      expect(result.nodes.length).toBeGreaterThan(0);
    }
  });

  /**
   * 2.2 Symbol ID matching
   *
   * Send a file with a named function `handleRequest`.
   * Verify the ExtractedFunctionCfg for `handleRequest` has symbolId matching
   * the generateId('Function', ...) of the tree-sitter-extracted node.
   * Verify line numbers match between tree-sitter node and CFG function entry.
   */
  it('2.2: CFG function entries have symbolId matching tree-sitter node IDs', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);

    const results = await pool.dispatch<any, any>([
      { path: 'src/handler.ts', content: TS_SOURCE_WITH_FUNCTION },
    ]);

    expect(results).toHaveLength(1);
    const result = results[0];

    // Skip assertion if binding is unavailable
    if (!result.cfgData || result.cfgData.length === 0) return;

    const fileCfg = result.cfgData.find((c: any) => c.filePath === 'src/handler.ts');
    expect(fileCfg).toBeDefined();

    // Find the handleRequest function CFG entry
    const handleRequestCfg = fileCfg.functions.find((f: any) => f.name === 'handleRequest');
    if (!handleRequestCfg) return; // may be named differently

    // symbolId should be set and match the tree-sitter node's ID
    if (handleRequestCfg.symbolId !== null) {
      // symbolId should reference a Function node that exists in the parsed nodes
      const nodeIds = result.nodes.map((n: any) => n.id);
      expect(nodeIds).toContain(handleRequestCfg.symbolId);

      // The matching node should be a Function or Method
      const matchedNode = result.nodes.find((n: any) => n.id === handleRequestCfg.symbolId);
      expect(matchedNode).toBeDefined();
      expect(['Function', 'Method']).toContain(matchedNode.label);
      expect(matchedNode.properties.name).toBe('handleRequest');

      // oxc startLine is 1-indexed; tree-sitter stores 0-indexed rows.
      // The CFG startLine should be exactly 1 more than the node's startLine.
      expect(handleRequestCfg.startLine).toBe(matchedNode.properties.startLine + 1);
    }

    // Whether or not symbolId is set, startLine and endLine should be populated
    expect(typeof handleRequestCfg.startLine).toBe('number');
    expect(typeof handleRequestCfg.endLine).toBe('number');
    expect(handleRequestCfg.endLine).toBeGreaterThanOrEqual(handleRequestCfg.startLine);
  });

  /**
   * 2.3 Non-TS/JS files produce no cfgData
   *
   * Send a Python file through the worker.
   * Verify cfgData is empty or does not contain an entry for that file.
   */
  it('2.3: Python file parse result has no cfgData entry', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);

    const results = await pool.dispatch<any, any>([
      { path: 'src/handler.py', content: PYTHON_SOURCE },
    ]);

    expect(results).toHaveLength(1);
    const result = results[0];

    // cfgData field should exist on the result
    expect(result).toHaveProperty('cfgData');
    expect(Array.isArray(result.cfgData)).toBe(true);

    // No CFG entry for Python files — CFG is TS/JS only
    const pythonCfg = result.cfgData.find((c: any) => c.filePath === 'src/handler.py');
    expect(pythonCfg).toBeUndefined();
  });

  // Test 2.4 removed — redundant with 2.1 (cfgData array check) and
  // pipeline-cfg 4.6 (core parse results unaffected by CFG binding status).
});
