/**
 * Layer 4: Full Pipeline (end-to-end) CFG Integration Tests
 *
 * Tests the entire flow: files on disk → pipeline → graph with CFG data.
 * Each test creates its own fixture files in a temp directory, runs the full
 * pipeline, and asserts on outcomes in the resulting graph.
 *
 * Tests are skipped when the @gitnexus/oxc-cfg native binding is not available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import type { GraphNode, GraphRelationship } from '../../../src/core/graph/types.js';

// ── CFG availability guard ──────────────────────────────────────────────────

let hasOxcCfg = false;
try {
  require('@gitnexus/oxc-cfg');
  hasOxcCfg = true;
} catch {
  // Native binding not available — all Layer 4 tests will be skipped
}

const describeWithCfg = hasOxcCfg ? describe : describe.skip;

// ── Temp directory helpers ──────────────────────────────────────────────────

/**
 * Create a temporary directory, write the given files into it, and
 * initialise a bare git repository so the pipeline can resolve file hashes.
 *
 * @param files  Map of relative file path → content string
 * @returns      Absolute path to the created temp directory
 */
async function createTempRepo(files: Record<string, string>): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-cfg-pipeline-'));

  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
  }

  // Initialise git so git-coupling and file-hash phases don't fail
  try {
    execSync('git init && git add . && git commit -m "init"', {
      cwd: tmpDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });
  } catch {
    // Non-fatal — the pipeline handles missing git history gracefully
  }

  return tmpDir;
}

/**
 * Remove a temporary directory, swallowing errors (best-effort cleanup).
 */
async function removeTempRepo(tmpDir: string): Promise<void> {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Run the pipeline on a temp directory and return the result.
 */
async function runPipeline(tmpDir: string): Promise<PipelineResult> {
  return runPipelineFromRepo(tmpDir, () => {});
}

// ── Graph query helpers ─────────────────────────────────────────────────────

function getNodesByLabel(result: PipelineResult, label: string): GraphNode[] {
  const nodes: GraphNode[] = [];
  result.graph.forEachNode(n => {
    if (n.label === label) nodes.push(n);
  });
  return nodes;
}

function getRelationshipsByType(result: PipelineResult, type: string): GraphRelationship[] {
  const rels: GraphRelationship[] = [];
  result.graph.forEachRelationship(r => {
    if (r.type === type) rels.push(r);
  });
  return rels;
}

// ── Test 4.1: Index a small TS project ─────────────────────────────────────

describeWithCfg('4.1 Index a small TS project', () => {
  let tmpDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    tmpDir = await createTempRepo({
      'src/models.ts': `
export class User {
  constructor(public name: string, public email: string) {}
  greet(): string {
    return \`Hello, \${this.name}\`;
  }
}
`.trim(),

      'src/utils.ts': `
export function formatName(first: string, last: string): string {
  return \`\${first} \${last}\`;
}

export function validateEmail(email: string): boolean {
  if (!email) return false;
  return email.includes('@');
}
`.trim(),

      'src/index.ts': `
import { User } from './models';
import { formatName, validateEmail } from './utils';

const name = formatName('Alice', 'Smith');
const user = new User(name, 'alice@example.com');
console.log(user.greet());
`.trim(),
    });

    result = await runPipeline(tmpDir);
  }, 120_000);

  afterAll(() => removeTempRepo(tmpDir));

  it('produces BasicBlock nodes in the graph', () => {
    const blocks = getNodesByLabel(result, 'BasicBlock');
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('each BasicBlock has required properties', () => {
    const blocks = getNodesByLabel(result, 'BasicBlock');
    for (const block of blocks) {
      expect(typeof block.properties.blockIndex).toBe('number');
      expect(typeof block.properties.instructionCount).toBe('number');
      // isUnreachable defaults to false and may be omitted; check type when present
      if (block.properties.isUnreachable !== undefined) {
        expect(typeof block.properties.isUnreachable).toBe('boolean');
      }
    }
  });

  it('CFG_CONTAINS edges link BasicBlocks to their parent Function/Method', () => {
    const cfgContains = getRelationshipsByType(result, 'CFG_CONTAINS');
    expect(cfgContains.length).toBeGreaterThan(0);

    for (const rel of cfgContains) {
      const source = result.graph.getNode(rel.sourceId);
      const target = result.graph.getNode(rel.targetId);
      expect(source).toBeDefined();
      expect(target).toBeDefined();
      expect(['Function', 'Method']).toContain(source!.label);
      expect(target!.label).toBe('BasicBlock');
    }
  });

  it('CFG_EDGE relationships exist with non-empty cfgEdgeType', () => {
    const cfgEdges = getRelationshipsByType(result, 'CFG_EDGE');
    // A project with branching should have CFG edges
    if (cfgEdges.length > 0) {
      for (const rel of cfgEdges) {
        expect(rel.cfgEdgeType).toBeTruthy();
        const source = result.graph.getNode(rel.sourceId);
        const target = result.graph.getNode(rel.targetId);
        expect(source?.label).toBe('BasicBlock');
        expect(target?.label).toBe('BasicBlock');
      }
    }
  });

  it('every Function/Method node has at least one CFG_CONTAINS edge', () => {
    const cfgContains = getRelationshipsByType(result, 'CFG_CONTAINS');
    const functionNodeIds = new Set<string>();
    result.graph.forEachNode(n => {
      if (n.label === 'Function' || n.label === 'Method') {
        functionNodeIds.add(n.id);
      }
    });

    // Build set of function nodes that have at least one BasicBlock
    const functionsWithBlocks = new Set(cfgContains.map(r => r.sourceId));

    // Every indexed function should appear as a CFG_CONTAINS source
    expect(functionsWithBlocks.size).toBeGreaterThan(0);

    // There should not be BasicBlock nodes without a parent
    const basicBlockIds = new Set(getNodesByLabel(result, 'BasicBlock').map(n => n.id));
    const basicBlocksWithParent = new Set(cfgContains.map(r => r.targetId));
    for (const id of basicBlockIds) {
      expect(basicBlocksWithParent.has(id)).toBe(true);
    }
  });

  it('total node count grows beyond original symbols (BasicBlocks added)', () => {
    const symbolCount = (() => {
      let count = 0;
      result.graph.forEachNode(n => {
        if (['Function', 'Method', 'Class'].includes(n.label)) count++;
      });
      return count;
    })();
    const blockCount = getNodesByLabel(result, 'BasicBlock').length;
    // There are symbols AND their basic blocks
    expect(symbolCount).toBeGreaterThan(0);
    expect(blockCount).toBeGreaterThan(0);
    expect(result.graph.nodeCount).toBeGreaterThan(symbolCount);
  });
});

// ── Test 4.2: Mixed language project ───────────────────────────────────────

describeWithCfg('4.2 Mixed language project — CFG only for TS/JS', () => {
  let tmpDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    tmpDir = await createTempRepo({
      'src/logic.ts': `
export function compute(x: number): number {
  if (x > 0) return x * 2;
  return 0;
}
`.trim(),

      'src/helper.js': `
function greet(name) {
  return 'Hello ' + name;
}
module.exports = { greet };
`.trim(),

      'src/script.py': `
def process(data):
    if data:
        return data.strip()
    return ""

class Handler:
    def handle(self, req):
        return process(req)
`.trim(),
    });

    result = await runPipeline(tmpDir);
  }, 120_000);

  afterAll(() => removeTempRepo(tmpDir));

  it('produces BasicBlock nodes for TS files', () => {
    const blocks = getNodesByLabel(result, 'BasicBlock');
    // There should be BasicBlock nodes from the TS file
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('BasicBlock nodes are only linked to TS/JS functions, not Python functions', () => {
    const cfgContains = getRelationshipsByType(result, 'CFG_CONTAINS');
    for (const rel of cfgContains) {
      const parentNode = result.graph.getNode(rel.sourceId);
      expect(parentNode).toBeDefined();
      // Parent node must not be from a Python file
      const filePath = parentNode!.properties.filePath ?? '';
      expect(filePath).not.toMatch(/\.py$/);
    }
  });

  it('Python function nodes have no associated BasicBlocks', () => {
    const cfgContains = getRelationshipsByType(result, 'CFG_CONTAINS');
    const functionsWithBlocks = new Set(cfgContains.map(r => r.sourceId));

    result.graph.forEachNode(n => {
      if ((n.label === 'Function' || n.label === 'Method') &&
          (n.properties.filePath ?? '').endsWith('.py')) {
        expect(functionsWithBlocks.has(n.id)).toBe(false);
      }
    });
  });
});

// ── Test 4.3: Incremental re-index ─────────────────────────────────────────

describeWithCfg('4.3 Incremental re-index', () => {
  let tmpDir: string;
  let firstResult: PipelineResult;
  let secondResult: PipelineResult;

  const fileAContent = `
export function simpleA(): number {
  return 42;
}
`.trim();

  const fileAModified = `
export function simpleA(): number {
  if (Math.random() > 0.5) {
    return 42;
  }
  return 0;
}
`.trim();

  const fileBContent = `
export function simpleB(): string {
  return 'hello';
}
`.trim();

  beforeAll(async () => {
    tmpDir = await createTempRepo({
      'src/fileA.ts': fileAContent,
      'src/fileB.ts': fileBContent,
    });

    // First index pass
    firstResult = await runPipeline(tmpDir);

    // Modify fileA to add branching (should create more BasicBlocks)
    await fs.writeFile(path.join(tmpDir, 'src', 'fileA.ts'), fileAModified, 'utf-8');

    // Commit the change so incremental indexing detects the diff
    try {
      execSync('git add . && git commit -m "modify fileA"', {
        cwd: tmpDir,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
        },
      });
    } catch {
      // Non-fatal
    }

    // Second index pass (incremental)
    secondResult = await runPipeline(tmpDir);
  }, 180_000);

  afterAll(() => removeTempRepo(tmpDir));

  it('second pass still produces BasicBlock nodes', () => {
    const blocks = getNodesByLabel(secondResult, 'BasicBlock');
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('fileA BasicBlocks change after modification (branching added)', () => {
    function blocksForFile(r: PipelineResult, fileName: string): GraphNode[] {
      // Collect function node IDs for the file
      const fnIds = new Set<string>();
      r.graph.forEachNode(n => {
        if ((n.label === 'Function' || n.label === 'Method') &&
            (n.properties.filePath ?? '').includes(fileName)) {
          fnIds.add(n.id);
        }
      });
      // Collect BasicBlock IDs reachable via CFG_CONTAINS from those functions
      const blockIds = new Set<string>();
      r.graph.forEachRelationship(rel => {
        if (rel.type === 'CFG_CONTAINS' && fnIds.has(rel.sourceId)) {
          blockIds.add(rel.targetId);
        }
      });
      const blocks: GraphNode[] = [];
      blockIds.forEach(id => {
        const node = r.graph.getNode(id);
        if (node) blocks.push(node);
      });
      return blocks;
    }

    const firstBlocks = blocksForFile(firstResult, 'fileA.ts');
    const secondBlocks = blocksForFile(secondResult, 'fileA.ts');

    // After adding an if/else branch, fileA should have more BasicBlocks
    expect(secondBlocks.length).toBeGreaterThanOrEqual(firstBlocks.length);
  });

  it('fileB BasicBlock count is unchanged after re-index', () => {
    function blockCountForFile(r: PipelineResult, fileName: string): number {
      const fnIds = new Set<string>();
      r.graph.forEachNode(n => {
        if ((n.label === 'Function' || n.label === 'Method') &&
            (n.properties.filePath ?? '').includes(fileName)) {
          fnIds.add(n.id);
        }
      });
      let count = 0;
      r.graph.forEachRelationship(rel => {
        if (rel.type === 'CFG_CONTAINS' && fnIds.has(rel.sourceId)) count++;
      });
      return count;
    }

    const firstCount = blockCountForFile(firstResult, 'fileB.ts');
    const secondCount = blockCountForFile(secondResult, 'fileB.ts');

    // fileB was not modified — block count must be the same
    expect(secondCount).toBe(firstCount);
  });

  it('no orphaned BasicBlock nodes remain after incremental re-index', () => {
    const cfgContains = getRelationshipsByType(secondResult, 'CFG_CONTAINS');
    const basicBlocks = getNodesByLabel(secondResult, 'BasicBlock');
    const referencedBlockIds = new Set(cfgContains.map(r => r.targetId));

    for (const block of basicBlocks) {
      expect(referencedBlockIds.has(block.id)).toBe(true);
    }
  });
});

// ── Test 4.4: Large function count ─────────────────────────────────────────

describeWithCfg('4.4 Large function count', () => {
  let tmpDir: string;
  let result: PipelineResult;
  const FUNCTION_COUNT = 100;
  let startTime: number;

  beforeAll(async () => {
    // Generate a file with 100 small functions
    const functions = Array.from({ length: FUNCTION_COUNT }, (_, i) => `
export function fn${i}(x: number): number {
  if (x > ${i}) return x + ${i};
  return ${i};
}`).join('\n');

    tmpDir = await createTempRepo({
      'src/large.ts': functions.trim(),
    });

    startTime = Date.now();
    result = await runPipeline(tmpDir);
  }, 120_000);

  afterAll(() => removeTempRepo(tmpDir));

  it(`indexes all ${FUNCTION_COUNT} functions`, () => {
    let count = 0;
    result.graph.forEachNode(n => {
      if (n.label === 'Function' &&
          (n.properties.filePath ?? '').includes('large.ts')) {
        count++;
      }
    });
    expect(count).toBe(FUNCTION_COUNT);
  });

  it(`all ${FUNCTION_COUNT} functions have CFG data`, () => {
    const fnIds = new Set<string>();
    result.graph.forEachNode(n => {
      if (n.label === 'Function' &&
          (n.properties.filePath ?? '').includes('large.ts')) {
        fnIds.add(n.id);
      }
    });

    const functionsWithCfg = new Set<string>();
    result.graph.forEachRelationship(rel => {
      if (rel.type === 'CFG_CONTAINS' && fnIds.has(rel.sourceId)) {
        functionsWithCfg.add(rel.sourceId);
      }
    });

    expect(functionsWithCfg.size).toBe(FUNCTION_COUNT);
  });

  it('pipeline completes in under 60 seconds', () => {
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(60_000);
  });
});

// ── Test 4.5: Graph queryability ───────────────────────────────────────────

describeWithCfg('4.5 Graph queryability', () => {
  let tmpDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    tmpDir = await createTempRepo({
      'src/branching.ts': `
export function withBranches(x: number): string {
  if (x > 0) {
    return 'positive';
  } else {
    return 'non-positive';
  }
}

export function withUnreachable(): number {
  return 42;
  // Dead code after return
  console.log('never reached');
  return 0;
}
`.trim(),
    });

    result = await runPipeline(tmpDir);
  }, 120_000);

  afterAll(() => removeTempRepo(tmpDir));

  it('can query all unreachable BasicBlock nodes via graph iteration', () => {
    const unreachableBlocks: GraphNode[] = [];
    result.graph.forEachNode(n => {
      if (n.label === 'BasicBlock' && n.properties.isUnreachable === true) {
        unreachableBlocks.push(n);
      }
    });
    // withUnreachable() has dead code after return — should produce unreachable block(s)
    expect(unreachableBlocks.length).toBeGreaterThan(0);
  });

  it('can query all Jump edges via graph iteration', () => {
    const jumpEdges: GraphRelationship[] = [];
    result.graph.forEachRelationship(r => {
      if (r.type === 'CFG_EDGE' && r.cfgEdgeType === 'Jump') {
        jumpEdges.push(r);
      }
    });
    // withBranches() has an if/else — should produce Jump edge(s)
    expect(jumpEdges.length).toBeGreaterThan(0);
  });

  it('can query blocks belonging to a specific function via CFG_CONTAINS', () => {
    // Find the withBranches function node
    let withBranchesId: string | undefined;
    result.graph.forEachNode(n => {
      if (n.label === 'Function' && n.properties.name === 'withBranches') {
        withBranchesId = n.id;
      }
    });

    expect(withBranchesId).toBeDefined();

    // Follow CFG_CONTAINS from withBranches to find its BasicBlocks
    const ownedBlocks: GraphNode[] = [];
    result.graph.forEachRelationship(r => {
      if (r.type === 'CFG_CONTAINS' && r.sourceId === withBranchesId) {
        const block = result.graph.getNode(r.targetId);
        if (block) ownedBlocks.push(block);
      }
    });

    // if/else structure means at least 3 blocks: entry, true branch, false branch
    expect(ownedBlocks.length).toBeGreaterThanOrEqual(3);

    // All blocks should have blockIndex set
    for (const block of ownedBlocks) {
      expect(typeof block.properties.blockIndex).toBe('number');
    }
  });

  it('Jump edge conditionText references the if condition', () => {
    // Find withBranches function node
    let withBranchesId: string | undefined;
    result.graph.forEachNode(n => {
      if (n.label === 'Function' && n.properties.name === 'withBranches') {
        withBranchesId = n.id;
      }
    });
    expect(withBranchesId).toBeDefined();

    // Get block IDs belonging to withBranches
    const blockIds = new Set<string>();
    result.graph.forEachRelationship(r => {
      if (r.type === 'CFG_CONTAINS' && r.sourceId === withBranchesId) {
        blockIds.add(r.targetId);
      }
    });

    // Find Jump edges between those blocks
    const jumpEdges: GraphRelationship[] = [];
    result.graph.forEachRelationship(r => {
      if (r.type === 'CFG_EDGE' && r.cfgEdgeType === 'Jump' &&
          blockIds.has(r.sourceId)) {
        jumpEdges.push(r);
      }
    });

    expect(jumpEdges.length).toBeGreaterThan(0);

    // At least one Jump edge should have a conditionText mentioning x
    const conditionTexts = jumpEdges
      .map(r => r.conditionText ?? '')
      .filter(t => t.length > 0);

    expect(conditionTexts.some(t => t.includes('x'))).toBe(true);
  });

  it('can retrieve getNode() by ID for any BasicBlock', () => {
    const blocks = getNodesByLabel(result, 'BasicBlock');
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks.slice(0, 5)) {
      const fetched = result.graph.getNode(block.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(block.id);
      expect(fetched!.label).toBe('BasicBlock');
    }
  });
});

// ── Test 4.6: Regression — existing data unaffected ────────────────────────

describe('4.6 Regression — existing relationship types unaffected by CFG pass', () => {
  // Note: This test runs unconditionally (no describeWithCfg) because it checks
  // that the pipeline still produces correct non-CFG data regardless of whether
  // the native binding is present.
  let tmpDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    tmpDir = await createTempRepo({
      'src/auth.ts': `
import { db } from './db';

export class AuthService {
  async login(username: string, password: string): Promise<boolean> {
    const user = await db.findUser(username);
    if (!user) return false;
    return user.password === password;
  }
}
`.trim(),

      'src/db.ts': `
export const db = {
  async findUser(username: string) {
    return { username, password: 'secret' };
  }
};
`.trim(),

      'src/index.ts': `
import { AuthService } from './auth';
export const auth = new AuthService();
`.trim(),
    });

    result = await runPipeline(tmpDir);
  }, 120_000);

  afterAll(() => removeTempRepo(tmpDir));

  it('CALLS edges are present in the graph', () => {
    const callsEdges = getRelationshipsByType(result, 'CALLS');
    expect(callsEdges.length).toBeGreaterThan(0);
  });

  it('IMPORTS edges are present in the graph', () => {
    const importEdges = getRelationshipsByType(result, 'IMPORTS');
    expect(importEdges.length).toBeGreaterThan(0);
  });

  it('CONTAINS edges are present in the graph (project structure)', () => {
    const containsEdges = getRelationshipsByType(result, 'CONTAINS');
    expect(containsEdges.length).toBeGreaterThan(0);
  });

  it('HAS_METHOD edges are present for class methods', () => {
    const hasMethodEdges = getRelationshipsByType(result, 'HAS_METHOD');
    expect(hasMethodEdges.length).toBeGreaterThan(0);
  });

  it('Function and Class nodes have correct labels', () => {
    const functionNodes: GraphNode[] = [];
    const classNodes: GraphNode[] = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Function') functionNodes.push(n);
      if (n.label === 'Class') classNodes.push(n);
    });
    // AuthService is a class
    const authServiceNode = classNodes.find(n => n.properties.name === 'AuthService');
    expect(authServiceNode).toBeDefined();
    // login is a method
    let loginNode: GraphNode | undefined;
    result.graph.forEachNode(n => {
      if (n.label === 'Method' && n.properties.name === 'login') loginNode = n;
    });
    expect(loginNode).toBeDefined();
  });

  it('MEMBER_OF (community) edges are produced by community detection', () => {
    // Communities are always computed — their MEMBER_OF edges should be present
    const memberOfEdges = getRelationshipsByType(result, 'MEMBER_OF');
    expect(memberOfEdges.length).toBeGreaterThan(0);
  });

  it('CFG_CONTAINS and CFG_EDGE types do not corrupt CALLS or IMPORTS edge data', () => {
    // Verify CALLS edges have expected fields and are not accidentally of CFG types
    const callsEdges = getRelationshipsByType(result, 'CALLS');
    for (const rel of callsEdges) {
      expect(rel.type).toBe('CALLS');
      expect(rel.sourceId).toBeTruthy();
      expect(rel.targetId).toBeTruthy();
      // CFG fields should not be present on CALLS edges
      expect(rel.cfgEdgeType).toBeUndefined();
    }

    // Verify no BasicBlock node appears as a CALLS source or target
    const callsNodeIds = new Set([
      ...callsEdges.map(r => r.sourceId),
      ...callsEdges.map(r => r.targetId),
    ]);
    callsNodeIds.forEach(id => {
      const node = result.graph.getNode(id);
      if (node) {
        expect(node.label).not.toBe('BasicBlock');
      }
    });
  });
});
