import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  compactContext,
  compactImpact,
  compactToolResult,
  withoutMcpVerboseArg,
} from '../../src/mcp/compact-output.js';
import { shapeImpactForAgent } from '../../src/mcp/impact-agent-output.js';
import { createMCPServer } from '../../src/mcp/server.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

/** Shaped like `_runImpactBFS` output after `shapeImpactForAgent`. */
const impactResult = () => ({
  target: {
    id: 'Method:src/auth/service.ts:AuthService.login',
    name: 'login',
    type: 'Method',
    filePath: 'src/auth/service.ts',
  },
  direction: 'upstream',
  impactedCount: 5,
  risk: 'HIGH',
  summary: { direct: 3, processes_affected: 2, modules_affected: 1 },
  byDepthCounts: { 1: 3, 2: 2 },
  affected_processes: [
    {
      name: 'LoginFlow',
      type: 'Function',
      filePath: 'src/a.ts',
      total_hits: 4,
      earliest_broken_step: 1,
    },
    {
      name: 'AdminFlow',
      type: 'Function',
      filePath: 'src/b.ts',
      total_hits: 1,
      earliest_broken_step: 2,
    },
  ],
  affected_modules: [{ name: 'Auth', hits: 3, impact: 'direct' }],
  affected_routes: [{ method: 'POST', url: '/login' }],
  byDepth: {
    1: [
      {
        depth: 1,
        id: 'Function:src/api/routes.ts:handleLogin',
        name: 'handleLogin',
        type: 'Function',
        filePath: 'src/api/routes.ts',
        relationType: 'CALLS',
        confidence: 1,
        processes: [{ id: 'p1', label: 'LoginFlow', processType: 'x', step: 1 }],
      },
      {
        depth: 1,
        id: 'Method:src/api/routes.ts:Router.mount',
        name: 'mount',
        type: 'Method',
        filePath: 'src/api/routes.ts',
        relationType: 'IMPLEMENTS',
        confidence: 0.5,
        processes: [],
      },
      {
        depth: 1,
        id: 'Function:src/cli.ts:run',
        name: 'run',
        type: 'Function',
        filePath: 'src/cli.ts',
        relationType: 'CALLS',
        confidence: 0.8,
        processes: [],
      },
    ],
    2: [
      {
        depth: 2,
        id: 'Function:src/main.ts:main',
        name: 'main',
        type: 'Function',
        filePath: 'src/main.ts',
        relationType: 'CALLS',
        confidence: 1,
        processes: [],
      },
    ],
  },
});

describe('compactImpact', () => {
  it('groups symbols by file under each depth, tagging unusual edges and low confidence', () => {
    expect(compactImpact(impactResult())).toBe(
      [
        'login (Method)  src/auth/service.ts  upstream · 5 impacted · risk HIGH (2 flows, 1 modules)',
        'depth 1 (3):',
        '  src/api/routes.ts: handleLogin#1f, Router.mount [implements]?',
        '  src/cli.ts: run',
        'depth 2 (showing 1 of 2):',
        '  src/main.ts: main',
        '(#Nf = flows through the symbol)',
        'flows (2): LoginFlow×4, AdminFlow',
        'modules (1): Auth(3,direct)',
        'routes (1): POST /login',
      ].join('\n'),
    );
  });

  it('lists co-changed files after the routes line', () => {
    const result: any = {
      ...impactResult(),
      co_changed: [
        { file: 'web/client.ts', strength: 0.8, count: 8 },
        { file: 'docs/auth.md', strength: 0.5, count: 4 },
      ],
    };
    const lines = compactImpact(result)!.split('\n');
    expect(lines.slice(-2)).toEqual([
      'routes (1): POST /login',
      'usually changes with: web/client.ts (8×), docs/auth.md (4×)',
    ]);
  });

  it('drops overload arity tags from names but keeps JS private names', () => {
    const item = (id: string, name: string, processCount: number) => ({
      depth: 1,
      id,
      name,
      type: 'Method',
      filePath: 'src/x.ts',
      relationType: 'CALLS',
      confidence: 1,
      processCount,
    });
    const result: any = {
      ...impactResult(),
      byDepthCounts: { 1: 3 },
      byDepth: {
        1: [
          item('Method:src/x.ts:Store.load#0', 'load', 0),
          item('Method:src/x.ts:Store.save#2', 'save', 6),
          item('Method:src/x.ts:Store.#flush', '#flush', 0),
        ],
      },
    };
    expect(compactImpact(result)!.split('\n')[2]).toBe(
      '  src/x.ts: Store.load, Store.save#6f, Store.#flush',
    );
  });

  it('shows processCount from a trimmed item and the pagination state', () => {
    const result: any = {
      ...impactResult(),
      pagination: { limit: 1, offset: 0, truncated: true },
      byDepthCounts: { 1: 40 },
      byDepth: {
        1: [
          {
            depth: 1,
            id: 'Function:src/x.ts:hub',
            name: 'hub',
            type: 'Function',
            filePath: 'src/x.ts',
            relationType: 'CALLS',
            confidence: 1,
            processes: [{}, {}, {}],
            processCount: 7,
          },
        ],
      },
      affected_processes: [],
      affected_modules: [],
      affected_routes: [],
    };
    expect(compactImpact(result)).toBe(
      [
        'login (Method)  src/auth/service.ts  upstream · 5 impacted · risk HIGH (2 flows, 1 modules)',
        'depth 1 (showing 1 of 40):',
        '  src/x.ts: hub#7f',
        '(#Nf = flows through the symbol)',
        'pagination: limit 1, offset 0, truncated',
      ].join('\n'),
    );
  });

  it('reports a budget trim after shapeImpactForAgent', () => {
    const big: any = impactResult();
    big.byDepth[1] = Array.from({ length: 50 }, (_, i) => ({
      depth: 1,
      id: `Function:src/f${i}.ts:fn${i}`,
      name: `fn${i}`,
      type: 'Function',
      filePath: `src/f${i}.ts`,
      relationType: 'CALLS',
      confidence: 1,
      processes: [],
    }));
    big.byDepthCounts = { 1: 50, 2: 1 };
    const shaped = shapeImpactForAgent(big, 400);
    const text = compactImpact(shaped)!;
    expect(shaped.pagination.trimmedForBudget.maxTokens).toBe(400);
    expect(text).toContain('pagination: truncated, trimmed for maxTokens 400, shown per depth {');
    expect(text).toMatch(/depth 1 \(showing \d+ of 50\):/);
  });

  it('caps long flow lists at 10 with a remainder count', () => {
    const result: any = impactResult();
    result.affected_processes = Array.from({ length: 13 }, (_, i) => ({
      name: `F${i}`,
      total_hits: 1,
    }));
    expect(compactImpact(result)).toContain(
      'flows (13): F0, F1, F2, F3, F4, F5, F6, F7, F8, F9 (+3 more)',
    );
  });

  it('keeps summaryOnly counts and unknown fields such as riskNote and partial', () => {
    const { byDepth: _omitted, ...summaryOnly } = impactResult() as any;
    summaryOnly.partial = true;
    summaryOnly.riskNote = 'lower bound';
    const text = compactImpact(summaryOnly)!;
    expect(text).toContain('depths: 1=3 2=2 (symbols omitted)');
    expect(text).toContain('partial: true');
    expect(text).toContain('riskNote: "lower bound"');
  });

  it.each([
    ['error', { error: 'boom', target: { name: 'x' } }],
    ['ambiguous', { status: 'ambiguous', candidates: [] }],
    ['group fan-out', { by_depth: {}, target: { name: 'x' } }],
    ['pdg', { ...impactResult(), mode: 'pdg' }],
    ['null', null],
  ])('returns null for %s so the caller falls back to JSON', (_name, input) => {
    expect(compactImpact(input)).toBeNull();
  });
});

const contextResult = () => ({
  status: 'found',
  symbol: {
    uid: 'Method:src/auth/service.ts:AuthService.login',
    name: 'login',
    kind: 'Method',
    filePath: 'src/auth/service.ts',
    startLine: 10,
    endLine: 42,
  },
  incoming: {
    calls: [
      {
        uid: 'Function:src/api/routes.ts:handleLogin',
        name: 'handleLogin',
        filePath: 'src/api/routes.ts',
        kind: 'Function',
      },
      {
        uid: 'Method:src/api/routes.ts:Router.mount',
        name: 'mount',
        filePath: 'src/api/routes.ts',
        kind: 'Method',
      },
    ],
    imports: [],
  },
  outgoing: {
    calls: [
      { uid: 'Function:src/db.ts:query', name: 'query', filePath: 'src/db.ts', kind: 'Function' },
    ],
    extends: [{ uid: 'File:src/base.ts', name: 'base.ts', filePath: 'src/base.ts', kind: 'File' }],
  },
  processes: [{ id: 'p1', name: 'LoginFlow', step_index: 2, step_count: 5 }],
  routes: [{ url: '/login', method: 'POST' }],
});

describe('compactContext', () => {
  it('lists relations per type and direction, one line per file', () => {
    expect(compactContext(contextResult())).toBe(
      [
        'login  Method  src/auth/service.ts:10-42',
        'in calls (2):',
        '  src/api/routes.ts: handleLogin, Router.mount',
        'out calls (1):',
        '  src/db.ts: query',
        'out extends (1):',
        '  src/base.ts: base.ts',
        'routes: POST /login',
        'flows (1): LoginFlow 2/5',
      ].join('\n'),
    );
  });

  it('appends retained source after a blank line and keeps metadata fields', () => {
    const result: any = contextResult();
    result.symbol.content = 'function login() {}';
    result.symbol.methodMetadata = { isAsync: true };
    result.epistemic = 'lower-bound';
    const text = compactContext(result)!;
    expect(text).toContain('methodMetadata: {"isAsync":true}');
    expect(text).toContain('epistemic: "lower-bound"');
    expect(text.endsWith('\n\nfunction login() {}')).toBe(true);
  });

  it('caps flows at 10', () => {
    const result: any = contextResult();
    result.processes = Array.from({ length: 12 }, (_, i) => ({
      name: `F${i}`,
      step_index: 1,
      step_count: 2,
    }));
    expect(compactContext(result)).toContain('(+2 more)');
  });

  it.each([
    ['not found', { status: 'not_found', error: 'nope' }],
    ['ambiguous', { status: 'ambiguous', candidates: [{ uid: 'a' }] }],
    ['error', { error: 'Repository not found' }],
  ])('returns null for %s', (_name, input) => {
    expect(compactContext(input)).toBeNull();
  });
});

describe('compactToolResult / withoutMcpVerboseArg', () => {
  it('only handles impact and context', () => {
    expect(compactToolResult('query', contextResult())).toBeNull();
    expect(compactToolResult('context', contextResult())).not.toBeNull();
  });

  it('removes verbose without mutating the input', () => {
    const args = { name: 'x', verbose: true };
    expect(withoutMcpVerboseArg(args)).toEqual({ name: 'x' });
    expect(args.verbose).toBe(true);
  });
});

describe('MCP boundary', () => {
  async function call(result: unknown, args: Record<string, unknown>, tool = 'context') {
    const backend = {
      callTool: vi.fn().mockResolvedValue(result),
      listRepos: vi.fn().mockResolvedValue([]),
      countRepos: vi.fn().mockResolvedValue(0),
      cachedRepoCount: vi.fn().mockReturnValue(0),
      resolveRepo: vi.fn().mockResolvedValue({ name: 't', repoPath: '/tmp/t', lastCommit: 'a' }),
      getContext: vi.fn().mockReturnValue(null),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const server = createMCPServer(backend as unknown as LocalBackend);
    const client = new Client({ name: 'compact-test', version: '0.0.0' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const response: any = await client.callTool({ name: tool, arguments: args });
      return { text: response.content[0].text as string, backend, isError: response.isError };
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('returns compact text by default for context', async () => {
    const { text, backend } = await call(contextResult(), { name: 'login', repo: 'r' });
    expect(text.startsWith('login  Method  src/auth/service.ts:10-42\nin calls (2):')).toBe(true);
    expect(text).toContain('**Next:**');
    expect(backend.callTool).toHaveBeenCalledWith('context', { name: 'login', repo: 'r' });
  });

  it('returns JSON with verbose and does not forward the flag', async () => {
    const { text, backend } = await call(contextResult(), {
      name: 'login',
      repo: 'r',
      verbose: true,
    });
    expect(JSON.parse(text.slice(0, text.indexOf('\n\n---')))).toEqual(contextResult());
    expect(backend.callTool).toHaveBeenCalledWith('context', { name: 'login', repo: 'r' });
  });

  it('returns compact text for impact and JSON with verbose', async () => {
    const compact = await call(impactResult(), { target: 'login', repo: 'r' }, 'impact');
    expect(
      compact.text.startsWith('login (Method)  src/auth/service.ts  upstream · 5 impacted'),
    ).toBe(true);
    // The default page limit still reaches the backend.
    expect(compact.backend.callTool).toHaveBeenCalledWith('impact', {
      target: 'login',
      repo: 'r',
      limit: 30,
    });
    const verbose = await call(
      impactResult(),
      { target: 'login', repo: 'r', verbose: true },
      'impact',
    );
    expect(
      JSON.parse(verbose.text.slice(0, verbose.text.indexOf('\n\n---'))).byDepthCounts,
    ).toEqual({
      1: 3,
      2: 2,
    });
  });

  it('falls back to JSON for ambiguous results', async () => {
    const ambiguous = { status: 'ambiguous', message: 'pick one', candidates: [{ uid: 'a' }] };
    const { text } = await call(ambiguous, { name: 'login', repo: 'r' });
    expect(JSON.parse(text.slice(0, text.indexOf('\n\n---')))).toEqual(ambiguous);
  });
});
