/**
 * dead_code exclusions on a hand-built graph: each symbol below is unreferenced
 * by CALLS, and only the ones with no reason to be invoked externally may be
 * reported.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { runQualityQuery, type QualityExecutor } from '../../src/mcp/local/quality-query.js';

const fn = (id: string, name: string, file: string, exported = false) =>
  `CREATE (n:Function {id: '${id}', name: '${name}', filePath: '${file}', startLine: 4, endLine: 9, isExported: ${exported}, content: '', description: '', convexEndpointFactory: '', complexity: 2, sloc: 5})`;
const method = (id: string, name: string, file: string) =>
  `CREATE (n:Method {id: '${id}', name: '${name}', filePath: '${file}', startLine: 4, endLine: 9, isExported: false, content: '', description: '', parameterCount: 0, returnType: '', complexity: 2, sloc: 5})`;
const edge = (from: string, fromLabel: string, to: string, toLabel: string, type: string) =>
  `MATCH (a:${fromLabel}), (b:${toLabel}) WHERE a.id = '${from}' AND b.id = '${to}'
   CREATE (a)-[:CodeRelation {type: '${type}', confidence: 1.0, reason: '', step: 0}]->(b)`;

const SEED = [
  fn('f:plain', 'plainDead', 'src/app.ts'),
  fn('f:exported', 'exportedDead', 'src/app.ts', true),
  fn('f:route', 'routeHandler', 'src/app.ts'),
  fn('f:entry', 'processEntry', 'src/app.ts'),
  fn('f:ref', 'passedAsCallback', 'src/app.ts'),
  fn('f:test', 'helperInTest', 'src/app.test.ts'),
  fn('f:caller', 'caller', 'src/app.ts', true),
  fn('f:callee', 'callee', 'src/app.ts'),
  method('m:impl', 'run', 'src/app.ts'),
  method('m:iface', 'run', 'src/api.ts'),
  method('m:dunder', '__repr__', 'src/app.py'),
  method('m:ctor', 'constructor', 'src/app.ts'),
  method('m:plain', 'unusedMethod', 'src/app.ts'),
  `CREATE (r:Route {id: 'route:1', name: '/x', filePath: 'src/app.ts'})`,
  `CREATE (p:Process {id: 'proc:1', label: 'P', heuristicLabel: 'P', processType: 'intra_community', stepCount: 1, communities: [], entryPointId: 'f:entry', terminalId: 'f:entry'})`,
  edge('f:route', 'Function', 'route:1', 'Route', 'HANDLES_ROUTE'),
  edge('f:caller', 'Function', 'f:callee', 'Function', 'CALLS'),
  edge('f:caller', 'Function', 'f:ref', 'Function', 'USES'),
  edge('m:impl', 'Method', 'm:iface', 'Method', 'METHOD_IMPLEMENTS'),
];

withTestLbugDB(
  'quality-query-dead-code',
  () => {
    let run: QualityExecutor;
    beforeAll(async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      run = (cypher, params) => adapter.executePrepared(cypher, params);
    });

    describe('dead_code', () => {
      it('reports only symbols nothing can reach', async () => {
        const r = await runQualityQuery(run, { preset: 'dead_code' });
        expect(r.lines.map((l) => l.split('  ')[0]).sort()).toEqual(['plainDead', 'unusedMethod']);
        expect(r.lines.find((l) => l.startsWith('plainDead'))).toBe('plainDead  src/app.ts:5  no-callers');
      });

      it('applies the path prefix', async () => {
        const r = await runQualityQuery(run, { preset: 'dead_code', path: 'src/api.ts' });
        expect(r.lines).toEqual([]);
      });
    });
  },
  { seed: SEED },
);
