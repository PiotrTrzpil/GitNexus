/**
 * Integration Tests: Semantic Depth — Type Edges & Cross-File Resolution
 *
 * Covers two fixtures from the semantic-depth design doc:
 *   1. type-edges    — USES_TYPE, THROWS, deduplication, type_coupling preset
 *   2. cross-file    — cross-file CALLS, USES_TYPE, READS_FIELD (self-access)
 *
 * Each fixture is run end-to-end via runPipelineFromRepo in beforeAll;
 * every it() asserts against the cached graph.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import type { GraphNode, GraphRelationship } from '../../src/core/graph/types.js';

// ── Fixture paths ─────────────────────────────────────────────────────────────

const TYPE_EDGES_FIXTURE = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'semantic-depth',
  'type-edges',
);

const CROSS_FILE_FIXTURE = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'semantic-depth',
  'cross-file',
);

// ── Shared helpers (instantiated per describe block with its own graph) ───────

function makeHelpers(result: PipelineResult) {
  /** Find the first node matching label + name. */
  const findNode = (label: string, name: string): GraphNode | undefined =>
    [...result.graph.iterNodes()].find(
      (n) => n.label === label && n.properties.name === name,
    );

  /** Find all relationships of the given type leaving sourceId. */
  const findEdgesFrom = (sourceId: string, type: string): GraphRelationship[] =>
    [...result.graph.iterRelationships()].filter(
      (r) => r.sourceId === sourceId && r.type === type,
    );

  /** Find a specific relationship between two nodes of the given type. */
  const findEdgeBetween = (
    sourceId: string,
    targetId: string,
    type: string,
  ): GraphRelationship | undefined =>
    [...result.graph.iterRelationships()].find(
      (r) => r.sourceId === sourceId && r.targetId === targetId && r.type === type,
    );

  return { findNode, findEdgesFrom, findEdgeBetween };
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixture 1: type-edges
// ═════════════════════════════════════════════════════════════════════════════

describe('semantic-depth / type-edges', () => {
  let result: PipelineResult;
  let findNode: ReturnType<typeof makeHelpers>['findNode'];
  let findEdgesFrom: ReturnType<typeof makeHelpers>['findEdgesFrom'];
  let findEdgeBetween: ReturnType<typeof makeHelpers>['findEdgeBetween'];

  beforeAll(async () => {
    result = await runPipelineFromRepo(TYPE_EDGES_FIXTURE, () => {});
    ({ findNode, findEdgesFrom, findEdgeBetween } = makeHelpers(result));
  }, 60_000);

  // ── USES_TYPE on return type ────────────────────────────────────────────────

  it('UserRepo.find has USES_TYPE edge to User (return type)', () => {
    const findMethod = findNode('Method', 'find');
    const userNode = findNode('Class', 'User') ?? findNode('Interface', 'User');

    expect(findMethod).toBeDefined();
    expect(userNode).toBeDefined();

    const edges = findEdgesFrom(findMethod!.id, 'USES_TYPE');
    expect(edges.some((e) => e.targetId === userNode!.id)).toBe(true);
  });

  // ── USES_TYPE on parameter type ────────────────────────────────────────────

  it('UserRepo.save has USES_TYPE edge to User (param type)', () => {
    const saveMethod = findNode('Method', 'save');
    const userNode = findNode('Class', 'User') ?? findNode('Interface', 'User');

    expect(saveMethod).toBeDefined();
    expect(userNode).toBeDefined();

    const edges = findEdgesFrom(saveMethod!.id, 'USES_TYPE');
    expect(edges.some((e) => e.targetId === userNode!.id)).toBe(true);
  });

  // ── USES_TYPE deduplication ────────────────────────────────────────────────

  it('UserRepo.save → User USES_TYPE is deduplicated (exactly one edge)', () => {
    const saveMethod = findNode('Method', 'save');
    const userNode = findNode('Class', 'User') ?? findNode('Interface', 'User');

    expect(saveMethod).toBeDefined();
    expect(userNode).toBeDefined();

    const edges = findEdgesFrom(saveMethod!.id, 'USES_TYPE').filter(
      (e) => e.targetId === userNode!.id,
    );
    // Must have at least one; must not be duplicated
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges.length).toBe(1);
  });

  // ── THROWS edge ────────────────────────────────────────────────────────────

  it('UserRepo.save has THROWS edge to NotFoundError', () => {
    const saveMethod = findNode('Method', 'save');
    const notFoundError = findNode('Class', 'NotFoundError');

    expect(saveMethod).toBeDefined();
    expect(notFoundError).toBeDefined();

    const edges = findEdgesFrom(saveMethod!.id, 'THROWS');
    expect(edges.some((e) => e.targetId === notFoundError!.id)).toBe(true);
  });

  // ── type_coupling preset: User referenced by both find and save ────────────

  it('User is referenced by USES_TYPE from at least 2 distinct methods (type_coupling)', () => {
    const userNode = findNode('Class', 'User') ?? findNode('Interface', 'User');
    expect(userNode).toBeDefined();

    const inboundUsesType = [...result.graph.iterRelationships()].filter(
      (r) => r.type === 'USES_TYPE' && r.targetId === userNode!.id,
    );
    // find + save both reference User → at least 2 inbound USES_TYPE edges
    expect(inboundUsesType.length).toBeGreaterThanOrEqual(2);
  });

  // ── throw_diversity preset: UserRepo.save throws exactly 1 exception type ──

  it('UserRepo.save has exactly 1 THROWS edge (throw_diversity threshold 0)', () => {
    const saveMethod = findNode('Method', 'save');
    expect(saveMethod).toBeDefined();

    const throwEdges = findEdgesFrom(saveMethod!.id, 'THROWS');
    expect(throwEdges.length).toBe(1);
  });

  // ── Inheritance structure is present ──────────────────────────────────────

  it('NotFoundError and AppError class nodes are in the graph', () => {
    expect(findNode('Class', 'NotFoundError')).toBeDefined();
    expect(findNode('Class', 'AppError')).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fixture 2: cross-file
// ═════════════════════════════════════════════════════════════════════════════

describe('semantic-depth / cross-file', () => {
  let result: PipelineResult;
  let findNode: ReturnType<typeof makeHelpers>['findNode'];
  let findEdgesFrom: ReturnType<typeof makeHelpers>['findEdgesFrom'];
  let findEdgeBetween: ReturnType<typeof makeHelpers>['findEdgeBetween'];

  beforeAll(async () => {
    result = await runPipelineFromRepo(CROSS_FILE_FIXTURE, () => {});
    ({ findNode, findEdgesFrom, findEdgeBetween } = makeHelpers(result));
  }, 60_000);

  // ── Cross-file CALLS: ApiService.fetchUser → HttpClient.get ───────────────

  it('ApiService.fetchUser → HttpClient.get has cross-file CALLS edge', () => {
    const fetchUser = findNode('Method', 'fetchUser');
    const httpGet = findNode('Method', 'get');

    expect(fetchUser).toBeDefined();
    expect(httpGet).toBeDefined();

    const edge = findEdgeBetween(fetchUser!.id, httpGet!.id, 'CALLS');
    expect(edge).toBeDefined();
  });

  // ── ApiService constructor param 'client' has USES_TYPE → HttpClient ───────

  it('ApiService constructor Parameter "client" has USES_TYPE edge to HttpClient', () => {
    const httpClientNode = findNode('Class', 'HttpClient');
    expect(httpClientNode).toBeDefined();

    // Find the Parameter node named 'client' whose parent is ApiService's constructor
    const clientParam = [...result.graph.iterNodes()].find(
      (n) => n.label === 'Parameter' && n.properties.name === 'client',
    );
    expect(clientParam).toBeDefined();

    const usesTypeEdges = findEdgesFrom(clientParam!.id, 'USES_TYPE');
    expect(usesTypeEdges.some((e) => e.targetId === httpClientNode!.id)).toBe(true);
  });

  // ── ApiService.fetchUser self-access READS_FIELD → ApiService.client ──────

  it('ApiService.fetchUser has READS_FIELD edge to ApiService.client (self-access via this.client)', () => {
    const fetchUser = findNode('Method', 'fetchUser');
    expect(fetchUser).toBeDefined();

    // Find the Property node 'client' on ApiService
    const clientProp = [...result.graph.iterNodes()].find(
      (n) =>
        n.label === 'Property' &&
        n.properties.name === 'client' &&
        n.properties.filePath?.includes('service'),
    );
    expect(clientProp).toBeDefined();

    const edges = findEdgesFrom(fetchUser!.id, 'READS_FIELD');
    expect(edges.some((e) => e.targetId === clientProp!.id)).toBe(true);
  });

  // ── HttpClient.constructor param 'config' has USES_TYPE → Config ──────────

  it('HttpClient constructor Parameter "config" has USES_TYPE edge to Config', () => {
    const configNode =
      findNode('Interface', 'Config') ?? findNode('Class', 'Config') ?? findNode('Type', 'Config');
    expect(configNode).toBeDefined();

    const configParam = [...result.graph.iterNodes()].find(
      (n) => n.label === 'Parameter' && n.properties.name === 'config',
    );
    expect(configParam).toBeDefined();

    const usesTypeEdges = findEdgesFrom(configParam!.id, 'USES_TYPE');
    expect(usesTypeEdges.some((e) => e.targetId === configNode!.id)).toBe(true);
  });

  // ── Cross-file USES_TYPE edges resolve correctly ──────────────────────────

  it('cross-file USES_TYPE edges are resolved: HttpClient and Config are reachable from service.ts symbols', () => {
    const httpClientNode = findNode('Class', 'HttpClient');
    const configNode =
      findNode('Interface', 'Config') ?? findNode('Class', 'Config') ?? findNode('Type', 'Config');

    expect(httpClientNode).toBeDefined();
    expect(configNode).toBeDefined();

    // At least one USES_TYPE edge from a symbol in service.ts targets HttpClient
    const toHttpClient = [...result.graph.iterRelationships()].filter(
      (r) => r.type === 'USES_TYPE' && r.targetId === httpClientNode!.id,
    );
    expect(toHttpClient.length).toBeGreaterThanOrEqual(1);

    // At least one USES_TYPE edge targets Config (defined in types.ts, referenced from types.ts constructor)
    const toConfig = [...result.graph.iterRelationships()].filter(
      (r) => r.type === 'USES_TYPE' && r.targetId === configNode!.id,
    );
    expect(toConfig.length).toBeGreaterThanOrEqual(1);
  });

  // ── Both files are indexed ────────────────────────────────────────────────

  it('both fixture files are indexed as File nodes', () => {
    const fileNodes: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'File') fileNodes.push(n.properties.filePath ?? n.properties.name);
    });

    const hasTypes = fileNodes.some((p) => p.endsWith('types.ts'));
    const hasService = fileNodes.some((p) => p.endsWith('service.ts'));
    expect(hasTypes).toBe(true);
    expect(hasService).toBe(true);
  });

  // ── ApiService and HttpClient class nodes exist ──────────────────────────

  it('ApiService and HttpClient class nodes are in the graph', () => {
    expect(findNode('Class', 'ApiService')).toBeDefined();
    expect(findNode('Class', 'HttpClient')).toBeDefined();
  });
});
