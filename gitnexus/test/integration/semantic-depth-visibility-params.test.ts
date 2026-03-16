/**
 * Integration Tests: Semantic Depth — Visibility/Access & Parameters
 *
 * Covers two fixtures from the semantic-depth design doc:
 *   1. visibility-and-access — property visibility modifiers, accessor flags,
 *      readonly/static, and READS_FIELD/WRITES_FIELD edges (including
 *      cross-class encapsulation violations and self-access).
 *   2. parameters — Parameter nodes with PARAM_OF edges, ordinal/optionality/
 *      rest metadata, constructor promotion, USES_TYPE edges to non-builtin
 *      types, and quality-query-equivalent graph assertions.
 *
 * Each fixture runs `runPipelineFromRepo` once in `beforeAll`; every `it()`
 * asserts against the cached in-memory graph. Quality-query presets are
 * verified by equivalent graph traversal logic (no backend required).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import type { GraphNode, GraphRelationship, KnowledgeGraph } from '../../src/core/graph/types.js';

// ─── Fixture paths ────────────────────────────────────────────────────────────

const VISIBILITY_FIXTURE = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'semantic-depth',
  'visibility-and-access',
);

const PARAMETERS_FIXTURE = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'semantic-depth',
  'parameters',
);

// ─── Test Harness Helpers ─────────────────────────────────────────────────────

/**
 * Find a single node by label and name.
 * Returns undefined when not found (test should assert it is defined).
 */
function findNode(graph: KnowledgeGraph, label: string, name: string): GraphNode | undefined {
  for (const node of graph.iterNodes()) {
    if (node.label === label && node.properties.name === name) {
      return node;
    }
  }
  return undefined;
}

/**
 * Find all edges originating from `sourceId` with the given relationship type.
 */
function findEdgesFrom(graph: KnowledgeGraph, sourceId: string, type: string): GraphRelationship[] {
  const results: GraphRelationship[] = [];
  for (const rel of graph.iterRelationships()) {
    if (rel.sourceId === sourceId && rel.type === type) {
      results.push(rel);
    }
  }
  return results;
}

/**
 * Find all edges pointing to `targetId` with the given relationship type.
 */
function findEdgesTo(graph: KnowledgeGraph, targetId: string, type: string): GraphRelationship[] {
  const results: GraphRelationship[] = [];
  for (const rel of graph.iterRelationships()) {
    if (rel.targetId === targetId && rel.type === type) {
      results.push(rel);
    }
  }
  return results;
}

// ─── Fixture 1: visibility-and-access ────────────────────────────────────────

describe('semantic-depth: visibility-and-access', () => {
  let result: PipelineResult;
  let graph: KnowledgeGraph;

  beforeAll(async () => {
    result = await runPipelineFromRepo(VISIBILITY_FIXTURE, () => {});
    graph = result.graph;
  }, 60000);

  // ── Property visibility modifiers ────────────────────────────────────────

  it('User.name Property node has visibility: public', () => {
    const prop = findNode(graph, 'Property', 'name');
    expect(prop).toBeDefined();
    expect(prop!.properties.visibility).toBe('public');
  });

  it('User.email Property node has visibility: private', () => {
    const prop = findNode(graph, 'Property', 'email');
    expect(prop).toBeDefined();
    expect(prop!.properties.visibility).toBe('private');
  });

  it('User.age Property node has visibility: protected', () => {
    const prop = findNode(graph, 'Property', 'age');
    expect(prop).toBeDefined();
    expect(prop!.properties.visibility).toBe('protected');
  });

  it('User.#ssn Property node has visibility: private (JS private field)', () => {
    // JS private fields use # prefix; node name may be stored as '#ssn' or 'ssn'
    const prop =
      findNode(graph, 'Property', '#ssn') ?? findNode(graph, 'Property', 'ssn');
    expect(prop).toBeDefined();
    expect(prop!.properties.visibility).toBe('private');
  });

  it('User.id Property node has isReadonly: true', () => {
    const prop = findNode(graph, 'Property', 'id');
    expect(prop).toBeDefined();
    expect(prop!.properties.isReadonly).toBe(true);
  });

  it('User.count Property node has isStatic: true', () => {
    const prop = findNode(graph, 'Property', 'count');
    expect(prop).toBeDefined();
    expect(prop!.properties.isStatic).toBe(true);
  });

  // ── Accessor detection ───────────────────────────────────────────────────

  it('User.fullName getter Method node has isAccessor: true', () => {
    // The graph may have one or two nodes for get/set — at least one must be an accessor
    let foundAccessor = false;
    for (const node of graph.iterNodes()) {
      if (
        (node.label === 'Method' || node.label === 'Property') &&
        node.properties.name === 'fullName' &&
        node.properties.isAccessor === true
      ) {
        foundAccessor = true;
        break;
      }
    }
    expect(foundAccessor).toBe(true);
  });

  // ── READS_FIELD edges ────────────────────────────────────────────────────

  it('UserService.doStuff → User.name has READS_FIELD edge', () => {
    const doStuff = findNode(graph, 'Method', 'doStuff');
    const nameProp = findNode(graph, 'Property', 'name');
    expect(doStuff).toBeDefined();
    expect(nameProp).toBeDefined();
    const edges = findEdgesFrom(graph, doStuff!.id, 'READS_FIELD');
    expect(edges.some(e => e.targetId === nameProp!.id)).toBe(true);
  });

  it('UserService.doStuff → User.email has READS_FIELD edge (cross-class private access)', () => {
    const doStuff = findNode(graph, 'Method', 'doStuff');
    const emailProp = findNode(graph, 'Property', 'email');
    expect(doStuff).toBeDefined();
    expect(emailProp).toBeDefined();
    const edges = findEdgesFrom(graph, doStuff!.id, 'READS_FIELD');
    expect(edges.some(e => e.targetId === emailProp!.id)).toBe(true);
  });

  // ── WRITES_FIELD edges ───────────────────────────────────────────────────

  it('UserService.doStuff → User.age has WRITES_FIELD edge (cross-class protected write)', () => {
    const doStuff = findNode(graph, 'Method', 'doStuff');
    const ageProp = findNode(graph, 'Property', 'age');
    expect(doStuff).toBeDefined();
    expect(ageProp).toBeDefined();
    const edges = findEdgesFrom(graph, doStuff!.id, 'WRITES_FIELD');
    expect(edges.some(e => e.targetId === ageProp!.id)).toBe(true);
  });

  // ── Self-access (User.validate → User.#ssn) ──────────────────────────────

  it('User.validate → User.#ssn has READS_FIELD edge with reason: self-access', () => {
    const validate = findNode(graph, 'Method', 'validate');
    const ssnProp =
      findNode(graph, 'Property', '#ssn') ?? findNode(graph, 'Property', 'ssn');
    expect(validate).toBeDefined();
    expect(ssnProp).toBeDefined();
    const edges = findEdgesFrom(graph, validate!.id, 'READS_FIELD');
    const ssnEdge = edges.find(e => e.targetId === ssnProp!.id);
    expect(ssnEdge).toBeDefined();
    expect(ssnEdge!.reason).toBe('self-access');
  });

  // ── Encapsulation violations (quality_query equivalent) ──────────────────

  it('encapsulation_violations: email and age accesses are returned, NOT name', () => {
    // Replicate quality_query({preset: 'encapsulation_violations'}) logic:
    // Cross-class READS_FIELD / WRITES_FIELD to private or protected Property nodes.
    const violations: Array<{ accessorName: string; fieldName: string; visibility: string; kind: string }> = [];

    for (const rel of graph.iterRelationships()) {
      if (rel.type !== 'READS_FIELD' && rel.type !== 'WRITES_FIELD') continue;
      const sourceNode = graph.getNode(rel.sourceId);
      const targetNode = graph.getNode(rel.targetId);
      if (!sourceNode || !targetNode) continue;
      // Skip self-access
      if (rel.reason === 'self-access') continue;
      const targetVisibility = targetNode.properties.visibility;
      if (targetVisibility === 'private' || targetVisibility === 'protected') {
        violations.push({
          accessorName: sourceNode.properties.name,
          fieldName: targetNode.properties.name,
          visibility: targetVisibility,
          kind: rel.type === 'READS_FIELD' ? 'read' : 'write',
        });
      }
    }

    const violatedFields = violations.map(v => v.fieldName);
    // email (private read) and age (protected write) should appear
    expect(violatedFields).toContain('email');
    expect(violatedFields.some(f => f === 'age')).toBe(true);
    // name is public — must NOT appear as a violation
    expect(violatedFields).not.toContain('name');
  });
});

// ─── Fixture 2: parameters ───────────────────────────────────────────────────

describe('semantic-depth: parameters', () => {
  let result: PipelineResult;
  let graph: KnowledgeGraph;

  beforeAll(async () => {
    result = await runPipelineFromRepo(PARAMETERS_FIXTURE, () => {});
    graph = result.graph;
  }, 60000);

  // ── handleRequest: 5 Parameter nodes ────────────────────────────────────

  it('handleRequest has 5 Parameter nodes with PARAM_OF edges', () => {
    const handleRequest =
      findNode(graph, 'Function', 'handleRequest') ??
      findNode(graph, 'Method', 'handleRequest');
    expect(handleRequest).toBeDefined();
    const paramEdges = findEdgesTo(graph, handleRequest!.id, 'PARAM_OF');
    expect(paramEdges).toHaveLength(5);
  });

  // ── ctx param ────────────────────────────────────────────────────────────

  it('ctx param: ordinal 0, isOptional false, isRest false', () => {
    const ctx = findNode(graph, 'Parameter', 'ctx');
    expect(ctx).toBeDefined();
    expect(ctx!.properties.ordinal).toBe(0);
    expect(ctx!.properties.isOptional).toBe(false);
    expect(ctx!.properties.isRest).toBe(false);
  });

  it('ctx param has USES_TYPE edge → RequestContext', () => {
    const ctx = findNode(graph, 'Parameter', 'ctx');
    expect(ctx).toBeDefined();
    const usesTypeEdges = findEdgesFrom(graph, ctx!.id, 'USES_TYPE');
    const requestContextNode =
      findNode(graph, 'Interface', 'RequestContext') ??
      findNode(graph, 'Type', 'RequestContext') ??
      findNode(graph, 'Class', 'RequestContext');
    expect(requestContextNode).toBeDefined();
    expect(usesTypeEdges.some(e => e.targetId === requestContextNode!.id)).toBe(true);
  });

  // ── method param ─────────────────────────────────────────────────────────

  it('method param: ordinal 2, hasDefault true, isOptional true', () => {
    const methodParam = findNode(graph, 'Parameter', 'method');
    expect(methodParam).toBeDefined();
    expect(methodParam!.properties.ordinal).toBe(2);
    expect(methodParam!.properties.hasDefault).toBe(true);
    expect(methodParam!.properties.isOptional).toBe(true);
  });

  // ── timeout param ────────────────────────────────────────────────────────

  it('timeout param: ordinal 3, isOptional true, hasDefault false', () => {
    const timeout = findNode(graph, 'Parameter', 'timeout');
    expect(timeout).toBeDefined();
    expect(timeout!.properties.ordinal).toBe(3);
    expect(timeout!.properties.isOptional).toBe(true);
    expect(timeout!.properties.hasDefault).toBe(false);
  });

  // ── middleware param ─────────────────────────────────────────────────────

  it('middleware param: ordinal 4, isRest true', () => {
    const middleware = findNode(graph, 'Parameter', 'middleware');
    expect(middleware).toBeDefined();
    expect(middleware!.properties.ordinal).toBe(4);
    expect(middleware!.properties.isRest).toBe(true);
  });

  // ── PaymentService constructor promotion ─────────────────────────────────

  it('PaymentService constructor has 3 Parameter nodes', () => {
    // Constructor may be labeled 'Constructor' or 'Method' named 'constructor'
    let constructorNode: GraphNode | undefined =
      findNode(graph, 'Constructor', 'constructor') ??
      findNode(graph, 'Constructor', 'PaymentService');
    // Fall back: look for a constructor-labeled node whose parent is PaymentService
    if (!constructorNode) {
      const paymentService = findNode(graph, 'Class', 'PaymentService');
      if (paymentService) {
        for (const node of graph.iterNodes()) {
          if (node.label !== 'Constructor' && !(node.label === 'Method' && node.properties.name === 'constructor')) continue;
          // Check if this constructor is contained within PaymentService file
          if (node.properties.filePath === paymentService.properties.filePath) {
            constructorNode = node;
            break;
          }
        }
      }
    }
    expect(constructorNode).toBeDefined();
    const paramEdges = findEdgesTo(graph, constructorNode!.id, 'PARAM_OF');
    expect(paramEdges).toHaveLength(3);
  });

  it('db param has visibility: private (constructor promotion)', () => {
    const db = findNode(graph, 'Parameter', 'db');
    expect(db).toBeDefined();
    expect(db!.properties.visibility).toBe('private');
  });

  it('db constructor promotion also creates a Property node PaymentService.db with visibility: private', () => {
    // The promoted field should appear as a Property node
    const dbProperty = findNode(graph, 'Property', 'db');
    expect(dbProperty).toBeDefined();
    expect(dbProperty!.properties.visibility).toBe('private');
  });

  it('cache param has visibility: protected and isOptional: true', () => {
    const cache = findNode(graph, 'Parameter', 'cache');
    expect(cache).toBeDefined();
    expect(cache!.properties.visibility).toBe('protected');
    expect(cache!.properties.isOptional).toBe(true);
  });

  // ── many_optionals quality_query equivalent ───────────────────────────────

  it('many_optionals (threshold: 2): handleRequest is returned', () => {
    // Count optional parameters per function. handleRequest has 3 optional:
    // method (hasDefault), timeout (?), middleware (rest/optional).
    const optionalCountByParent = new Map<string, number>();

    for (const rel of graph.iterRelationships()) {
      if (rel.type !== 'PARAM_OF') continue;
      const paramNode = graph.getNode(rel.sourceId);
      if (!paramNode || paramNode.label !== 'Parameter') continue;
      if (!paramNode.properties.isOptional) continue;
      const parentId = rel.targetId;
      optionalCountByParent.set(parentId, (optionalCountByParent.get(parentId) ?? 0) + 1);
    }

    const threshold = 2;
    const functionsAboveThreshold: string[] = [];
    for (const [parentId, count] of optionalCountByParent) {
      if (count > threshold) {
        const parentNode = graph.getNode(parentId);
        if (parentNode) functionsAboveThreshold.push(parentNode.properties.name);
      }
    }

    expect(functionsAboveThreshold).toContain('handleRequest');
  });

  // ── unused_injections quality_query equivalent ────────────────────────────

  it('unused_injections: cache is returned (never referenced by charge or refund)', () => {
    // Find promoted constructor params (visibility set) whose corresponding
    // Property node has zero READS_FIELD edges from sibling methods.
    const paymentService = findNode(graph, 'Class', 'PaymentService');
    expect(paymentService).toBeDefined();

    // Collect Property nodes belonging to PaymentService by file path
    const paymentServiceProps: GraphNode[] = [];
    for (const node of graph.iterNodes()) {
      if (
        node.label === 'Property' &&
        node.properties.filePath === paymentService!.properties.filePath
      ) {
        paymentServiceProps.push(node);
      }
    }

    // Find methods of PaymentService (charge, refund, etc.)
    const paymentServiceMethods: GraphNode[] = [];
    for (const node of graph.iterNodes()) {
      if (
        (node.label === 'Method' || node.label === 'Function') &&
        node.properties.filePath === paymentService!.properties.filePath &&
        node.properties.name !== 'constructor'
      ) {
        paymentServiceMethods.push(node);
      }
    }

    // For each promoted property, check if any sibling method reads it
    const unusedInjections: string[] = [];
    for (const prop of paymentServiceProps) {
      const isReferencedBySiblingMethod = paymentServiceMethods.some(method => {
        const reads = findEdgesFrom(graph, method.id, 'READS_FIELD');
        return reads.some(e => e.targetId === prop.id);
      });
      if (!isReferencedBySiblingMethod) {
        unusedInjections.push(prop.properties.name);
      }
    }

    // cache is never used in charge() or refund()
    expect(unusedInjections).toContain('cache');
    // db and logger ARE used — should NOT be in unused list
    expect(unusedInjections).not.toContain('db');
    expect(unusedInjections).not.toContain('logger');
  });

  // ── params_by_type quality_query equivalent ───────────────────────────────

  it('params_by_type (type: RequestContext): returns ctx', () => {
    const requestContextNode =
      findNode(graph, 'Interface', 'RequestContext') ??
      findNode(graph, 'Type', 'RequestContext') ??
      findNode(graph, 'Class', 'RequestContext');
    expect(requestContextNode).toBeDefined();

    // Find Parameter nodes with USES_TYPE → RequestContext
    const paramsUsingRequestContext: string[] = [];
    for (const rel of graph.iterRelationships()) {
      if (rel.type !== 'USES_TYPE') continue;
      if (rel.targetId !== requestContextNode!.id) continue;
      const sourceNode = graph.getNode(rel.sourceId);
      if (sourceNode?.label === 'Parameter') {
        paramsUsingRequestContext.push(sourceNode.properties.name);
      }
    }

    expect(paramsUsingRequestContext).toContain('ctx');
  });

  // ── USES_TYPE Cypher equivalent ───────────────────────────────────────────

  it('USES_TYPE edges from Parameters include RequestContext:1, Database:1, Logger:1', () => {
    // Replicate: MATCH (p:Parameter)-[:USES_TYPE]->(t) RETURN t.name, COUNT(p)
    const typeCountByName = new Map<string, number>();

    for (const rel of graph.iterRelationships()) {
      if (rel.type !== 'USES_TYPE') continue;
      const sourceNode = graph.getNode(rel.sourceId);
      if (!sourceNode || sourceNode.label !== 'Parameter') continue;
      const targetNode = graph.getNode(rel.targetId);
      if (!targetNode) continue;
      const typeName = targetNode.properties.name;
      typeCountByName.set(typeName, (typeCountByName.get(typeName) ?? 0) + 1);
    }

    expect(typeCountByName.get('RequestContext')).toBe(1);
    expect(typeCountByName.get('Database')).toBe(1);
    expect(typeCountByName.get('Logger')).toBe(1);
  });
});
