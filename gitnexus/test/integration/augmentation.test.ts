/**
 * Integration Tests: Augmentation Engine
 *
 * augment() against a real indexed LadybugDB
 *   - Matching pattern returns non-empty string with callers/callees
 *   - Non-matching pattern returns empty string
 *   - Pattern shorter than 3 chars returns empty string
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

// ─── Seed data & FTS indexes for augmentation ────────

const AUGMENT_SEED_DATA = [
  // File nodes
  `CREATE (n:File {id: 'file:auth.ts', name: 'auth.ts', filePath: 'src/auth.ts', content: 'authentication module for user login'})`,
  `CREATE (n:File {id: 'file:utils.ts', name: 'utils.ts', filePath: 'src/utils.ts', content: 'utility functions for hashing'})`,

  // Function nodes
  `CREATE (n:Function {id: 'func:login', name: 'login', filePath: 'src/auth.ts', startLine: 1, endLine: 15, isExported: true, content: 'function login authenticates user credentials', description: 'user login'})`,
  `CREATE (n:Function {id: 'func:validate', name: 'validate', filePath: 'src/auth.ts', startLine: 17, endLine: 25, isExported: true, content: 'function validate checks user input', description: 'input validation'})`,
  `CREATE (n:Function {id: 'func:hash', name: 'hash', filePath: 'src/utils.ts', startLine: 1, endLine: 8, isExported: true, content: 'function hash computes bcrypt hash', description: 'password hashing'})`,
  ...Array.from(
    { length: 5 },
    (_, i) =>
      `CREATE (n:Function {id: 'a:login-${i}', name: 'loginPartial${i}', filePath: 'src/login-partial-${i}.ts', startLine: 1, endLine: 2, isExported: true, content: 'partial login match ${i}', description: 'login partial'})`,
  ),

  // Class / Method / Interface nodes
  `CREATE (n:Class {id: 'class:AuthService', name: 'AuthService', filePath: 'src/auth.ts', startLine: 30, endLine: 60, isExported: true, content: 'class AuthService handles authentication', description: 'auth service'})`,
  `CREATE (n:Method {id: 'method:AuthService.login', name: 'loginMethod', filePath: 'src/auth.ts', startLine: 35, endLine: 50, isExported: false, content: 'method login in AuthService', description: 'login method'})`,
  `CREATE (n:Interface {id: 'iface:Creds', name: 'Credentials', filePath: 'src/auth.ts', startLine: 1, endLine: 5, isExported: true, content: 'interface Credentials for login authentication', description: 'credentials type'})`,

  // Community & Process nodes
  `CREATE (n:Community {id: 'comm:auth', label: 'Auth', heuristicLabel: 'Authentication', keywords: ['auth'], description: 'Auth cluster', enrichedBy: 'heuristic', cohesion: 0.8, symbolCount: 3})`,
  `CREATE (n:Process {id: 'proc:login-flow', label: 'LoginFlow', heuristicLabel: 'User Login', processType: 'intra_community', stepCount: 2, communities: ['auth'], entryPointId: 'func:login', terminalId: 'func:validate'})`,

  // Relationships
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:login' AND b.id = 'func:validate'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:login' AND b.id = 'func:hash'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'import-resolved', step: 0}]->(b)`,
  `MATCH (a:Function), (c:Community) WHERE a.id = 'func:login' AND c.id = 'comm:auth'
   CREATE (a)-[:CodeRelation {type: 'MEMBER_OF', confidence: 1.0, reason: '', step: 0}]->(c)`,
  `MATCH (a:Function), (p:Process) WHERE a.id = 'func:login' AND p.id = 'proc:login-flow'
   CREATE (a)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: '', step: 1}]->(p)`,
  `MATCH (a:Function), (p:Process) WHERE a.id = 'func:validate' AND p.id = 'proc:login-flow'
   CREATE (a)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: '', step: 2}]->(p)`,

  // Exact-name vs partial-name symbols (BM25 only ever sees the partial's file)
  `CREATE (n:Function {id: 'func:load_settings', name: 'load_settings', filePath: 'src/config.ts', startLine: 1, endLine: 5, isExported: true, content: 'config loader', description: 'loader'})`,
  `CREATE (n:Function {id: 'a:load_settings_cache', name: 'load_settings_cache', filePath: 'src/cache.ts', startLine: 1, endLine: 5, isExported: true, content: 'cache of settings', description: 'cache'})`,
  `CREATE (n:Function {id: 'func:read_json', name: 'read_json', filePath: 'src/io.ts', startLine: 1, endLine: 5, isExported: true, content: 'reads json', description: 'json reader'})`,

  // hotTarget: 5 callers, 4 callees, 5 flows (over the cap of 3)
  `CREATE (n:Function {id: 'func:hotTarget', name: 'hotTarget', filePath: 'src/hot.ts', startLine: 1, endLine: 5, isExported: true, content: 'hot', description: 'hot'})`,
  // coldTarget: 2 callers, 1 callee, 1 flow (within the cap)
  `CREATE (n:Function {id: 'func:coldTarget', name: 'coldTarget', filePath: 'src/cold.ts', startLine: 1, endLine: 5, isExported: true, content: 'cold', description: 'cold'})`,
  ...Array.from(
    { length: 5 },
    (_, i) =>
      `CREATE (n:Function {id: 'func:hotCaller${i}', name: 'hotCaller${i}', filePath: 'src/hot-callers.ts', startLine: ${i + 1}, endLine: ${i + 1}, isExported: true, content: 'c', description: 'c'})`,
  ),
  ...Array.from(
    { length: 4 },
    (_, i) =>
      `CREATE (n:Function {id: 'func:hotCallee${i}', name: 'hotCallee${i}', filePath: 'src/hot-callees.ts', startLine: ${i + 1}, endLine: ${i + 1}, isExported: true, content: 'c', description: 'c'})`,
  ),
  ...Array.from(
    { length: 2 },
    (_, i) =>
      `CREATE (n:Function {id: 'func:coldCaller${i}', name: 'coldCaller${i}', filePath: 'src/cold-callers.ts', startLine: ${i + 1}, endLine: ${i + 1}, isExported: true, content: 'c', description: 'c'})`,
  ),
  `CREATE (n:Function {id: 'func:coldCallee', name: 'coldCallee', filePath: 'src/cold-callees.ts', startLine: 1, endLine: 1, isExported: true, content: 'c', description: 'c'})`,
  ...Array.from(
    { length: 5 },
    (_, i) =>
      `CREATE (n:Process {id: 'proc:hot-${i}', label: 'Hot${i}', heuristicLabel: 'HotFlow${i}', processType: 'intra_community', stepCount: 3, communities: [], entryPointId: 'func:hotTarget', terminalId: 'func:hotTarget'})`,
  ),
  `CREATE (n:Process {id: 'proc:cold', label: 'Cold', heuristicLabel: 'ColdFlow', processType: 'intra_community', stepCount: 2, communities: [], entryPointId: 'func:coldTarget', terminalId: 'func:coldTarget'})`,
  ...Array.from(
    { length: 5 },
    (_, i) =>
      `MATCH (a:Function), (b:Function) WHERE a.id = 'func:hotCaller${i}' AND b.id = 'func:hotTarget'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
  ),
  ...Array.from(
    { length: 4 },
    (_, i) =>
      `MATCH (a:Function), (b:Function) WHERE a.id = 'func:hotTarget' AND b.id = 'func:hotCallee${i}'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
  ),
  ...Array.from(
    { length: 2 },
    (_, i) =>
      `MATCH (a:Function), (b:Function) WHERE a.id = 'func:coldCaller${i}' AND b.id = 'func:coldTarget'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
  ),
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:coldTarget' AND b.id = 'func:coldCallee'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
  ...Array.from(
    { length: 5 },
    (_, i) =>
      `MATCH (a:Function), (p:Process) WHERE a.id = 'func:hotTarget' AND p.id = 'proc:hot-${i}'
   CREATE (a)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: '', step: 1}]->(p)`,
  ),
  `MATCH (a:Function), (p:Process) WHERE a.id = 'func:coldTarget' AND p.id = 'proc:cold'
   CREATE (a)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: '', step: 1}]->(p)`,
];

const AUGMENT_FTS_INDEXES = [
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
  { table: 'Class', indexName: 'class_fts', columns: ['name', 'content', 'description'] },
  { table: 'Method', indexName: 'method_fts', columns: ['name', 'content', 'description'] },
  { table: 'Interface', indexName: 'interface_fts', columns: ['name', 'content', 'description'] },
];

// Mock repo-manager so augment() finds our test DB
vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn(),
}));

vi.mock('../../src/storage/storage-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/storage-resolver.js')>();
  return {
    ...actual,
    requireRegisteredStoragePath: vi.fn(
      async (entry: { storagePath: string }) => entry.storagePath,
    ),
  };
});

let augment: (pattern: string, cwd?: string) => Promise<string>;
let augmentNoFts: (pattern: string, cwd?: string) => Promise<string>;

withTestLbugDB(
  'augment',
  (handle) => {
    describe('augment()', () => {
      it('returns non-empty string with relationship info for a matching pattern', async () => {
        const result = await augment('login', handle.dbPath);

        expect(result.length).toBeGreaterThan(0);
        expect(result).toContain('[GitNexus]');
        expect(result).toContain('login');
      });

      it('returns empty string for a non-matching pattern', async () => {
        const result = await augment('nonexistent_xyz', handle.dbPath);
        expect(result).toBe('');
      });

      it('returns empty string for patterns shorter than 3 characters', async () => {
        const result = await augment('ab', handle.dbPath);
        expect(result).toBe('');
      });

      it('returns empty string for empty pattern', async () => {
        const result = await augment('', handle.dbPath);
        expect(result).toBe('');
      });

      // ─── Unhappy paths ────────────────────────────────────────────────

      it('returns empty string for whitespace-only pattern', async () => {
        const result = await augment('   ', handle.dbPath);
        expect(result).toBe('');
      });

      it('handles special regex characters in pattern without throwing', async () => {
        const result = await augment('func()', handle.dbPath);
        expect(typeof result).toBe('string');
      });

      it('handles very long pattern without throwing', async () => {
        const result = await augment('a'.repeat(500), handle.dbPath);
        expect(typeof result).toBe('string');
      });

      it('handles unicode pattern without throwing', async () => {
        const result = await augment('日本語テスト', handle.dbPath);
        expect(typeof result).toBe('string');
      });

      it('silently degrades when the registered storage path fails validation', async () => {
        const { requireRegisteredStoragePath } =
          await import('../../src/storage/storage-resolver.js');
        const resolverMock = vi.mocked(requireRegisteredStoragePath);
        resolverMock.mockRejectedValueOnce(new Error('foreign storage'));

        const result = await augment('login', handle.dbPath);

        expect(result).toBe('');
      });

      it('falls back to graph names when FTS is available but BM25 returns empty', async () => {
        const bm25 = await import('../../src/core/search/bm25-index.js');
        const spy = vi
          .spyOn(bm25, 'searchFTSFromLbug')
          .mockResolvedValue({ results: [], ftsAvailable: true });
        try {
          // FTS health does not imply its top file results contain the symbol's
          // definition. The graph-name fallback must recover the exact node.
          const result = await augment('login', handle.dbPath);
          expect(result).toContain('[GitNexus]');
          expect(result).toMatch(/^login \(src\/auth\.ts\)$/m);
        } finally {
          spy.mockRestore();
        }
      });

      it('finds an exact-name symbol when FTS ranks only mentioning files', async () => {
        const bm25 = await import('../../src/core/search/bm25-index.js');
        const spy = vi.spyOn(bm25, 'searchFTSFromLbug').mockResolvedValue({
          results: Array.from({ length: 5 }, (_, i) => ({
            filePath: `src/caller-${i}.ts`,
            score: 100 - i,
            rank: i + 1,
            nodeIds: [`file:caller-${i}`],
          })),
          ftsAvailable: true,
        });
        try {
          // Five partial login matches have IDs that sort before func:login, so
          // the five-row fallback only retains the exact node when exact names
          // rank ahead of partial matches.
          const result = await augment('login', handle.dbPath);
          expect(result).toContain('[GitNexus]');
          expect(result).toMatch(/^login \(src\/auth\.ts\)$/m);
        } finally {
          spy.mockRestore();
        }
      });

      describe('exact identifier lookup', () => {
        const mockBm25Files = async (filePaths: string[]) => {
          const bm25 = await import('../../src/core/search/bm25-index.js');
          return vi.spyOn(bm25, 'searchFTSFromLbug').mockResolvedValue({
            results: filePaths.map((filePath, i) => ({
              filePath,
              score: 100 - i,
              rank: i + 1,
              nodeIds: [`file:${i}`],
            })),
            ftsAvailable: true,
          });
        };

        it('prefers an exact-name symbol over partial matches in the files BM25 ranks', async () => {
          const spy = await mockBm25Files(['src/cache.ts']);
          try {
            const result = await augment('load_settings', handle.dbPath);
            expect(result).toMatch(/^load_settings \(src\/config\.ts\)$/m);
            expect(result).not.toContain('load_settings_cache');
          } finally {
            spy.mockRestore();
          }
        });

        it.each([
          ['read_json\\(', 'read_json (src/io.ts)'],
          ['def\\s+load_settings', 'load_settings (src/config.ts)'],
        ])('resolves the regex-escaped pattern %s to its identifier', async (pattern, header) => {
          const spy = await mockBm25Files([]);
          try {
            const result = await augment(pattern, handle.dbPath);
            expect(result.split('\n')).toContain(header);
          } finally {
            spy.mockRestore();
          }
        });
      });

      describe('neighbour totals', () => {
        it('shows how many callers, callees and flows are not listed', async () => {
          const result = await augment('hotTarget', handle.dbPath);
          expect(result).toContain('Called by: ');
          expect(result).toMatch(/Called by: (\w+, ){2}\w+ \(\+2 more\)$/m);
          expect(result).toMatch(/Calls: (\w+, ){2}\w+ \(\+1 more\)$/m);
          expect(result).toMatch(
            /Flows: (HotFlow\d \(step 1\/3\), ){2}HotFlow\d \(step 1\/3\) \(\+2 more\)$/m,
          );
        });

        it('omits "+N more" when everything fits in the cap', async () => {
          const result = await augment('coldTarget', handle.dbPath);
          expect(result).toMatch(/Called by: coldCaller0, coldCaller1$/m);
          expect(result).toMatch(/Calls: coldCallee$/m);
          expect(result).toMatch(/Flows: ColdFlow \(step 1\/2\)$/m);
          expect(result).not.toContain('more)');
        });
      });

      describe('root path matching', () => {
        it('matches repo at root level and CWD in sub-directory (repo at /, CWD at /src)', async () => {
          const { listRegisteredRepos } = await import('../../src/storage/repo-manager.js');
          const rootPath = path.resolve('/');

          (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
            {
              name: handle.repoId,
              path: rootPath,
              storagePath: handle.tmpHandle.dbPath,
              indexedAt: new Date().toISOString(),
              lastCommit: 'abc123',
            },
          ]);

          try {
            const subDir = path.join(rootPath, 'src');
            const result = await augment('login', subDir);
            expect(result.length).toBeGreaterThan(0);
            expect(result).toContain('[GitNexus]');
          } finally {
            (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
              {
                name: handle.repoId,
                path: handle.dbPath,
                storagePath: handle.tmpHandle.dbPath,
                indexedAt: new Date().toISOString(),
                lastCommit: 'abc123',
              },
            ]);
          }
        });

        it('does not attach a nested registered checkout from a parent cwd (repo at /src, CWD at /)', async () => {
          const { listRegisteredRepos } = await import('../../src/storage/repo-manager.js');
          const rootPath = path.resolve('/');
          const subDir = path.join(rootPath, 'src');

          (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
            {
              name: handle.repoId,
              path: subDir,
              storagePath: handle.tmpHandle.dbPath,
              indexedAt: new Date().toISOString(),
              lastCommit: 'abc123',
            },
          ]);

          try {
            const result = await augment('login', rootPath);
            expect(result).toBe('');
          } finally {
            (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
              {
                name: handle.repoId,
                path: handle.dbPath,
                storagePath: handle.tmpHandle.dbPath,
                indexedAt: new Date().toISOString(),
                lastCommit: 'abc123',
              },
            ]);
          }
        });

        if (process.platform === 'win32') {
          it('matches Windows drive-root repo and sub-directory CWD (repo at C:\\, CWD at C:\\src)', async () => {
            const { listRegisteredRepos } = await import('../../src/storage/repo-manager.js');

            (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
              {
                name: handle.repoId,
                path: 'C:\\',
                storagePath: handle.tmpHandle.dbPath,
                indexedAt: new Date().toISOString(),
                lastCommit: 'abc123',
              },
            ]);

            try {
              const result = await augment('login', 'C:\\src');
              expect(result.length).toBeGreaterThan(0);
            } finally {
              (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
                {
                  name: handle.repoId,
                  path: handle.dbPath,
                  storagePath: handle.tmpHandle.dbPath,
                  indexedAt: new Date().toISOString(),
                  lastCommit: 'abc123',
                },
              ]);
            }
          });

          it('does not attach a nested Windows checkout from a drive-root cwd (repo at C:\\src, CWD at C:\\)', async () => {
            const { listRegisteredRepos } = await import('../../src/storage/repo-manager.js');

            (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
              {
                name: handle.repoId,
                path: 'C:\\src',
                storagePath: handle.tmpHandle.dbPath,
                indexedAt: new Date().toISOString(),
                lastCommit: 'abc123',
              },
            ]);

            try {
              const result = await augment('login', 'C:\\');
              expect(result).toBe('');
            } finally {
              (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
                {
                  name: handle.repoId,
                  path: handle.dbPath,
                  storagePath: handle.tmpHandle.dbPath,
                  indexedAt: new Date().toISOString(),
                  lastCommit: 'abc123',
                },
              ]);
            }
          });
        }
      });
    });
  },
  {
    seed: AUGMENT_SEED_DATA,
    ftsIndexes: AUGMENT_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      // Configure mock to return our test DB so augment() can find it
      const { listRegisteredRepos } = await import('../../src/storage/repo-manager.js');
      (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          name: handle.repoId,
          path: handle.dbPath,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
        },
      ]);

      // Dynamically import augment after mocks are in place
      const engine = await import('../../src/core/augmentation/engine.js');
      augment = engine.augment;
    },
  },
);

// ─── FTS-unavailable suite: exercises the CONTAINS fallback branch ────────────
//
// No ftsIndexes → searchFTSFromLbug returns ftsAvailable: false → fallback fires.
// Same seed data so 'login' still exists as a graph node.

withTestLbugDB(
  'augment-no-fts',
  (handle) => {
    describe('augment() — FTS indexes unavailable (CONTAINS fallback)', () => {
      it('falls back to CONTAINS query and returns enrichment when FTS is unavailable', async () => {
        const result = await augmentNoFts('login', handle.dbPath);

        expect(result.length).toBeGreaterThan(0);
        expect(result).toContain('[GitNexus]');
      });

      it("returns empty string for whitespace-only pattern (CONTAINS '' guard)", async () => {
        const result = await augmentNoFts('    ', handle.dbPath);
        expect(result).toBe('');
      });

      it('returns empty string when no nodes match the CONTAINS query', async () => {
        const result = await augmentNoFts('nxyz_notfound', handle.dbPath);
        expect(result).toBe('');
      });

      it('returns empty string when fallback CONTAINS query throws', async () => {
        const poolAdapter = await import('../../src/core/lbug/pool-adapter.js');
        const spy = vi
          .spyOn(poolAdapter, 'executeQuery')
          .mockRejectedValue(new Error('simulated DB error'));
        try {
          const result = await augmentNoFts('login', handle.dbPath);
          expect(result).toBe('');
        } finally {
          spy.mockRestore();
        }
      });
    });
  },
  {
    seed: AUGMENT_SEED_DATA,
    // Intentionally no ftsIndexes — forces searchFTSFromLbug to return ftsAvailable: false
    poolAdapter: true,
    afterSetup: async (handle) => {
      const { listRegisteredRepos } = await import('../../src/storage/repo-manager.js');
      (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          name: handle.repoId,
          path: handle.dbPath,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
        },
      ]);

      const engine = await import('../../src/core/augmentation/engine.js');
      augmentNoFts = engine.augment;
    },
  },
);
