/**
 * Integration Tests: ts-morph rename
 *
 * Tests the TypeScript language service-powered rename against real
 * filesystem TS projects. Each test creates a temp directory with source
 * files and a tsconfig, then verifies that tsMorphRename produces
 * scope-aware, semantically correct edits.
 *
 * Categories:
 * 1. Basic rename behavior (dry run, apply, edit format)
 * 2. Scope awareness (shadowing, block scope, closures)
 * 3. Import/export patterns (named, barrel, alias, default, namespace)
 * 4. Type system (types, interfaces, generics, enums)
 * 5. Class features (methods, properties, inheritance, overrides)
 * 6. Advanced patterns (destructuring, JSX, decorators, overloads)
 * 7. Error handling (missing files, invalid inputs, propagation)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { tsMorphRename, isTypeScriptFile } from '../../src/core/rename/ts-morph-rename.js';

// ─── Helpers ────────────────────────────────────────────────────────────

interface TempProject {
  root: string;
  cleanup: () => Promise<void>;
}

/** Create a temp directory with files and a tsconfig.json. */
async function createTempProject(
  files: Record<string, string>,
  tsConfigOverrides?: Record<string, unknown>,
): Promise<TempProject> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-morph-rename-'));

  await fs.writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        allowJs: true,
        jsx: 'react-jsx',
        experimentalDecorators: true,
        ...tsConfigOverrides,
      },
      include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    }),
  );

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  return {
    root,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); },
  };
}

/** Read a file from the temp project. */
async function readFile(project: TempProject, filePath: string): Promise<string> {
  return fs.readFile(path.join(project.root, filePath), 'utf-8');
}

/** Shorthand to run a rename and assert it produced edits. */
async function renameAndAssert(
  project: TempProject,
  opts: { filePath: string; line: number; oldName: string; newName: string; dryRun?: boolean },
) {
  const result = await tsMorphRename({
    repoPath: project.root,
    dryRun: opts.dryRun ?? false,
    ...opts,
  });
  expect(result.status).toBe('success');
  if (result.status !== 'success') throw new Error('Expected success');
  expect(result.edits.length).toBeGreaterThan(0);
  for (const edit of result.edits) {
    expect(edit.confidence).toBe('ts_morph');
    expect(edit.line).toBeGreaterThan(0);
    expect(edit.filePath).toBeTruthy();
  }
  return result.edits;
}

// ─── isTypeScriptFile ───────────────────────────────────────────────────

describe('isTypeScriptFile', () => {
  it.each([
    ['file.ts', true],
    ['file.tsx', true],
    ['file.js', true],
    ['file.jsx', true],
    ['file.mts', true],
    ['file.cts', true],
    ['file.mjs', true],
    ['file.cjs', true],
    ['file.py', false],
    ['file.go', false],
    ['file.rs', false],
    ['file', false],
  ])('%s → %s', (file, expected) => {
    expect(isTypeScriptFile(file)).toBe(expected);
  });
});

// ─── tsMorphRename ──────────────────────────────────────────────────────

describe('tsMorphRename', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Basic rename behavior
  // ═══════════════════════════════════════════════════════════════════════

  describe('basic function rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/math.ts': [
          'export function calculateSum(a: number, b: number): number {',
          '  return a + b;',
          '}',
          '',
          'export function multiply(a: number, b: number): number {',
          '  return calculateSum(a, 0) + a * b;',
          '}',
        ].join('\n'),
        'src/main.ts': [
          'import { calculateSum } from "./math";',
          '',
          'const result = calculateSum(1, 2);',
          'console.log(result);',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('finds all references in dry run without modifying files', async () => {
      const edits = await renameAndAssert(project, {
        filePath: 'src/math.ts',
        line: 1,
        oldName: 'calculateSum',
        newName: 'add',
        dryRun: true,
      });

      // definition + internal call in math.ts + import + usage in main.ts
      expect(edits.length).toBeGreaterThanOrEqual(3);

      const files = new Set(edits.map(e => e.filePath));
      expect(files).toContain('src/math.ts');
      expect(files).toContain('src/main.ts');

      // Dry run must NOT modify files
      const content = await readFile(project, 'src/math.ts');
      expect(content).toContain('calculateSum');
    });

    it('applies rename when dryRun is false', async () => {
      const edits = await renameAndAssert(project, {
        filePath: 'src/math.ts',
        line: 1,
        oldName: 'calculateSum',
        newName: 'add',
      });

      expect(edits.length).toBeGreaterThanOrEqual(3);

      const mathContent = await readFile(project, 'src/math.ts');
      expect(mathContent).toContain('export function add(');
      expect(mathContent).toContain('return add(a, 0)');
      expect(mathContent).not.toContain('calculateSum');

      const mainContent = await readFile(project, 'src/main.ts');
      expect(mainContent).toContain('import { add } from "./math"');
      expect(mainContent).toContain('const result = add(1, 2)');
      expect(mainContent).not.toContain('calculateSum');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Scope awareness
  // ═══════════════════════════════════════════════════════════════════════

  describe('scope awareness: shadowed locals', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/scopes.ts': [
          'export function process(input: string): string {',
          '  return input.trim();',
          '}',
          '',
          'export function handler() {',
          '  const process = (x: number) => x * 2;',
          '  return process(42);',
          '}',
        ].join('\n'),
        'src/caller.ts': [
          'import { process } from "./scopes";',
          '',
          'export const result = process("hello");',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames exported function without touching shadowed locals', async () => {
      await renameAndAssert(project, {
        filePath: 'src/scopes.ts',
        line: 1,
        oldName: 'process',
        newName: 'transform',
      });

      const scopesContent = await readFile(project, 'src/scopes.ts');
      expect(scopesContent).toContain('export function transform(');
      // The shadowed local must be untouched
      expect(scopesContent).toContain('const process = (x: number)');
      expect(scopesContent).toContain('return process(42)');

      const callerContent = await readFile(project, 'src/caller.ts');
      expect(callerContent).toContain('import { transform } from "./scopes"');
      expect(callerContent).toContain('transform("hello")');
    });
  });

  describe('scope awareness: block-scoped variables', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/blocks.ts': [
          'export function outer() {',
          '  const count = 10;',
          '  if (true) {',
          '    const count = 20;',
          '    console.log(count);',
          '  }',
          '  return count;',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames outer variable without touching block-scoped shadow', async () => {
      await renameAndAssert(project, {
        filePath: 'src/blocks.ts',
        line: 2,
        oldName: 'count',
        newName: 'total',
      });

      const content = await readFile(project, 'src/blocks.ts');
      expect(content).toContain('const total = 10;');
      expect(content).toContain('return total;');
      // Block-scoped shadow must be untouched
      expect(content).toContain('const count = 20;');
      expect(content).toContain('console.log(count);');
    });
  });

  describe('scope awareness: closure capture', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/closure.ts': [
          'export function makeCounter() {',
          '  let value = 0;',
          '  return {',
          '    increment: () => { value++; },',
          '    get: () => value,',
          '  };',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames captured variable through closures', async () => {
      await renameAndAssert(project, {
        filePath: 'src/closure.ts',
        line: 2,
        oldName: 'value',
        newName: 'count',
      });

      const content = await readFile(project, 'src/closure.ts');
      expect(content).toContain('let count = 0;');
      expect(content).toContain('count++;');
      expect(content).toContain('() => count,');
      expect(content).not.toMatch(/\bvalue\b/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Import/export patterns
  // ═══════════════════════════════════════════════════════════════════════

  describe('named imports and barrel re-exports', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/core.ts': [
          'export function validateEmail(email: string): boolean {',
          '  return email.includes("@");',
          '}',
        ].join('\n'),
        'src/index.ts': [
          'export { validateEmail } from "./core";',
        ].join('\n'),
        'src/consumer.ts': [
          'import { validateEmail } from "./index";',
          '',
          'export function checkUser(email: string) {',
          '  if (!validateEmail(email)) {',
          '    throw new Error("Invalid email");',
          '  }',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates definition, barrel re-export, and consumer import', async () => {
      const edits = await renameAndAssert(project, {
        filePath: 'src/core.ts',
        line: 1,
        oldName: 'validateEmail',
        newName: 'isValidEmail',
      });

      const files = new Set(edits.map(e => e.filePath));
      expect(files).toContain('src/core.ts');
      expect(files).toContain('src/index.ts');
      expect(files).toContain('src/consumer.ts');

      expect(await readFile(project, 'src/core.ts')).toContain('export function isValidEmail(');
      expect(await readFile(project, 'src/index.ts')).toContain('export { isValidEmail } from "./core"');

      const consumerContent = await readFile(project, 'src/consumer.ts');
      expect(consumerContent).toContain('import { isValidEmail } from "./index"');
      expect(consumerContent).toContain('if (!isValidEmail(email))');
    });
  });

  describe('aliased imports', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/lib.ts': [
          'export function fetchData(url: string) {',
          '  return url;',
          '}',
        ].join('\n'),
        'src/app.ts': [
          'import { fetchData as getData } from "./lib";',
          '',
          'export const result = getData("/api");',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames the original export; alias stays unchanged', async () => {
      await renameAndAssert(project, {
        filePath: 'src/lib.ts',
        line: 1,
        oldName: 'fetchData',
        newName: 'requestData',
      });

      expect(await readFile(project, 'src/lib.ts')).toContain('export function requestData(');

      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('import { requestData as getData }');
      expect(appContent).toContain('getData("/api")');
    });
  });

  describe('default export rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/logger.ts': [
          'export default function logMessage(msg: string) {',
          '  console.log(msg);',
          '}',
          '',
          'logMessage("startup");',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames the default-exported function at definition site', async () => {
      await renameAndAssert(project, {
        filePath: 'src/logger.ts',
        line: 1,
        oldName: 'logMessage',
        newName: 'writeLog',
      });

      const content = await readFile(project, 'src/logger.ts');
      expect(content).toContain('export default function writeLog(');
      expect(content).toContain('writeLog("startup")');
      expect(content).not.toMatch(/\blogMessage\b/);
    });
  });

  describe('namespace import rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/utils.ts': [
          'export function formatDate(d: Date) { return d.toISOString(); }',
          'export function formatNumber(n: number) { return n.toFixed(2); }',
        ].join('\n'),
        'src/app.ts': [
          'import * as utils from "./utils";',
          '',
          'export const d = utils.formatDate(new Date());',
          'export const n = utils.formatNumber(3.14);',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames function accessed via namespace import', async () => {
      await renameAndAssert(project, {
        filePath: 'src/utils.ts',
        line: 1,
        oldName: 'formatDate',
        newName: 'toISODate',
      });

      expect(await readFile(project, 'src/utils.ts')).toContain('export function toISODate(');

      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('utils.toISODate(');
      // formatNumber must not be touched
      expect(appContent).toContain('utils.formatNumber(');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Type system
  // ═══════════════════════════════════════════════════════════════════════

  describe('type alias rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/types.ts': [
          'export type UserId = string;',
          '',
          'export interface User {',
          '  id: UserId;',
          '  name: string;',
          '}',
        ].join('\n'),
        'src/store.ts': [
          'import type { UserId, User } from "./types";',
          '',
          'const users = new Map<UserId, User>();',
          '',
          'export function getUser(id: UserId): User | undefined {',
          '  return users.get(id);',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames type alias across definition and all usages', async () => {
      await renameAndAssert(project, {
        filePath: 'src/types.ts',
        line: 1,
        oldName: 'UserId',
        newName: 'UserIdentifier',
      });

      const typesContent = await readFile(project, 'src/types.ts');
      expect(typesContent).toContain('export type UserIdentifier = string;');
      expect(typesContent).toContain('id: UserIdentifier;');

      const storeContent = await readFile(project, 'src/store.ts');
      expect(storeContent).toContain('import type { UserIdentifier, User }');
      expect(storeContent).toContain('new Map<UserIdentifier, User>()');
      expect(storeContent).toContain('export function getUser(id: UserIdentifier)');
      expect(storeContent).not.toMatch(/\bUserId\b/);
    });
  });

  describe('generic type parameter rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/container.ts': [
          'export class Container<TItem> {',
          '  private items: TItem[] = [];',
          '',
          '  add(item: TItem): void {',
          '    this.items.push(item);',
          '  }',
          '',
          '  getAll(): TItem[] {',
          '    return this.items;',
          '  }',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames generic type parameter within its scope', async () => {
      await renameAndAssert(project, {
        filePath: 'src/container.ts',
        line: 1,
        oldName: 'TItem',
        newName: 'TElement',
      });

      const content = await readFile(project, 'src/container.ts');
      expect(content).toContain('class Container<TElement>');
      expect(content).toContain('private items: TElement[]');
      expect(content).toContain('add(item: TElement)');
      expect(content).toContain('getAll(): TElement[]');
      expect(content).not.toMatch(/\bTItem\b/);
    });
  });

  describe('enum member rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/status.ts': [
          'export enum Status {',
          '  Active = "ACTIVE",',
          '  Inactive = "INACTIVE",',
          '}',
        ].join('\n'),
        'src/check.ts': [
          'import { Status } from "./status";',
          '',
          'export function isActive(s: Status): boolean {',
          '  return s === Status.Active;',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames enum member in definition and dot-access usage', async () => {
      await renameAndAssert(project, {
        filePath: 'src/status.ts',
        line: 2,
        oldName: 'Active',
        newName: 'Enabled',
      });

      const statusContent = await readFile(project, 'src/status.ts');
      expect(statusContent).toContain('Enabled = "ACTIVE"');
      expect(statusContent).not.toMatch(/\bActive\b/);

      const checkContent = await readFile(project, 'src/check.ts');
      expect(checkContent).toContain('Status.Enabled');
      expect(checkContent).not.toContain('Status.Active');
    });
  });

  describe('interface rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/types.ts': [
          'export interface UserProfile {',
          '  name: string;',
          '  age: number;',
          '}',
        ].join('\n'),
        'src/service.ts': [
          'import type { UserProfile } from "./types";',
          '',
          'export function greet(user: UserProfile): string {',
          '  return `Hello ${user.name}`;',
          '}',
          '',
          'export function createProfile(): UserProfile {',
          '  return { name: "test", age: 0 };',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames interface in definition, type annotations, and return types', async () => {
      await renameAndAssert(project, {
        filePath: 'src/types.ts',
        line: 1,
        oldName: 'UserProfile',
        newName: 'PersonProfile',
      });

      expect(await readFile(project, 'src/types.ts')).toContain('export interface PersonProfile {');

      const serviceContent = await readFile(project, 'src/service.ts');
      expect(serviceContent).toContain('import type { PersonProfile }');
      expect(serviceContent).toContain('user: PersonProfile');
      expect(serviceContent).toContain('createProfile(): PersonProfile');
      expect(serviceContent).not.toMatch(/\bUserProfile\b/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Class features
  // ═══════════════════════════════════════════════════════════════════════

  describe('class method rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/service.ts': [
          'export class UserService {',
          '  fetchUser(id: string) {',
          '    return { id, name: "test" };',
          '  }',
          '',
          '  deleteUser(id: string) {',
          '    const user = this.fetchUser(id);',
          '    return user;',
          '  }',
          '}',
        ].join('\n'),
        'src/handler.ts': [
          'import { UserService } from "./service";',
          '',
          'const svc = new UserService();',
          'const user = svc.fetchUser("123");',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames method in definition, this-calls, and external usage', async () => {
      await renameAndAssert(project, {
        filePath: 'src/service.ts',
        line: 2,
        oldName: 'fetchUser',
        newName: 'getUser',
      });

      const serviceContent = await readFile(project, 'src/service.ts');
      expect(serviceContent).toContain('getUser(id: string)');
      expect(serviceContent).toContain('this.getUser(id)');
      expect(serviceContent).not.toContain('fetchUser');

      const handlerContent = await readFile(project, 'src/handler.ts');
      expect(handlerContent).toContain('svc.getUser("123")');
      expect(handlerContent).not.toContain('fetchUser');
    });
  });

  describe('class rename with inheritance', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/base.ts': [
          'export class BaseLogger {',
          '  log(msg: string) { console.log(msg); }',
          '}',
        ].join('\n'),
        'src/child.ts': [
          'import { BaseLogger } from "./base";',
          '',
          'export class AppLogger extends BaseLogger {',
          '  error(msg: string) { super.log(`ERROR: ${msg}`); }',
          '}',
        ].join('\n'),
        'src/app.ts': [
          'import { BaseLogger } from "./base";',
          '',
          'const logger: BaseLogger = new BaseLogger();',
          'logger.log("hello");',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames class across extends clause and type annotations', async () => {
      await renameAndAssert(project, {
        filePath: 'src/base.ts',
        line: 1,
        oldName: 'BaseLogger',
        newName: 'CoreLogger',
      });

      expect(await readFile(project, 'src/base.ts')).toContain('export class CoreLogger {');

      const childContent = await readFile(project, 'src/child.ts');
      expect(childContent).toContain('import { CoreLogger }');
      expect(childContent).toContain('extends CoreLogger');

      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('import { CoreLogger }');
      expect(appContent).toContain('const logger: CoreLogger');
      expect(appContent).toContain('new CoreLogger()');
      expect(appContent).not.toMatch(/\bBaseLogger\b/);
    });
  });

  describe('class property rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/model.ts': [
          'export class Config {',
          '  retryCount: number = 3;',
          '',
          '  shouldRetry() {',
          '    return this.retryCount > 0;',
          '  }',
          '}',
        ].join('\n'),
        'src/app.ts': [
          'import { Config } from "./model";',
          '',
          'const cfg = new Config();',
          'console.log(cfg.retryCount);',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames property in declaration, this-access, and external access', async () => {
      await renameAndAssert(project, {
        filePath: 'src/model.ts',
        line: 2,
        oldName: 'retryCount',
        newName: 'maxAttempts',
      });

      const modelContent = await readFile(project, 'src/model.ts');
      expect(modelContent).toContain('maxAttempts: number = 3;');
      expect(modelContent).toContain('this.maxAttempts > 0');

      expect(await readFile(project, 'src/app.ts')).toContain('cfg.maxAttempts');
      expect(await readFile(project, 'src/app.ts')).not.toContain('retryCount');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Advanced patterns
  // ═══════════════════════════════════════════════════════════════════════

  describe('destructuring — interface property', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/config.ts': [
          'export interface AppConfig {',
          '  maxRetries: number;',
          '  timeout: number;',
          '}',
          '',
          'export const defaultConfig: AppConfig = {',
          '  maxRetries: 3,',
          '  timeout: 5000,',
          '};',
        ].join('\n'),
        'src/client.ts': [
          'import type { AppConfig } from "./config";',
          'import { defaultConfig } from "./config";',
          '',
          'export function createClient(overrides?: Partial<AppConfig>) {',
          '  const { maxRetries, timeout } = { ...defaultConfig, ...overrides };',
          '  return { maxRetries, timeout };',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames interface property through destructuring', async () => {
      await renameAndAssert(project, {
        filePath: 'src/config.ts',
        line: 2,
        oldName: 'maxRetries',
        newName: 'retryLimit',
      });

      const configContent = await readFile(project, 'src/config.ts');
      expect(configContent).toContain('retryLimit: number;');
      expect(configContent).toContain('retryLimit: 3,');

      const clientContent = await readFile(project, 'src/client.ts');
      expect(clientContent).toContain('retryLimit');
      expect(clientContent).toContain('const { retryLimit, timeout }');
    });
  });

  describe('comments and strings are preserved', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/utils.ts': [
          '/** The formatDate function formats a date. */',
          'export function formatDate(d: Date): string {',
          '  // formatDate uses toISOString internally',
          '  const label = "formatDate output";',
          '  return d.toISOString();',
          '}',
        ].join('\n'),
        'src/caller.ts': [
          'import { formatDate } from "./utils";',
          'console.log(formatDate(new Date()));',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames identifiers but preserves comments and string literals', async () => {
      await renameAndAssert(project, {
        filePath: 'src/utils.ts',
        line: 2,
        oldName: 'formatDate',
        newName: 'toDateString',
      });

      const content = await readFile(project, 'src/utils.ts');
      expect(content).toContain('export function toDateString(');
      // String literal must NOT be renamed
      expect(content).toContain('"formatDate output"');

      const callerContent = await readFile(project, 'src/caller.ts');
      expect(callerContent).toContain('import { toDateString }');
      expect(callerContent).toContain('toDateString(new Date())');
    });
  });

  describe('JSX component rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/Button.tsx': [
          'interface ButtonProps { label: string; }',
          '',
          'export function ActionButton({ label }: ButtonProps) {',
          '  return <button>{label}</button>;',
          '}',
        ].join('\n'),
        'src/App.tsx': [
          'import { ActionButton } from "./Button";',
          '',
          'export function App() {',
          '  return <ActionButton label="Click me" />;',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames component in definition and JSX usage', async () => {
      await renameAndAssert(project, {
        filePath: 'src/Button.tsx',
        line: 3,
        oldName: 'ActionButton',
        newName: 'PrimaryButton',
      });

      expect(await readFile(project, 'src/Button.tsx')).toContain('export function PrimaryButton(');

      const appContent = await readFile(project, 'src/App.tsx');
      expect(appContent).toContain('import { PrimaryButton }');
      expect(appContent).toContain('<PrimaryButton label="Click me" />');
      expect(appContent).not.toContain('ActionButton');
    });
  });

  describe('overloaded function rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/parse.ts': [
          'export function parse(input: string): object;',
          'export function parse(input: Buffer): object;',
          'export function parse(input: string | Buffer): object {',
          '  return typeof input === "string" ? JSON.parse(input) : JSON.parse(input.toString());',
          '}',
        ].join('\n'),
        'src/caller.ts': [
          'import { parse } from "./parse";',
          '',
          'export const data = parse("{}");',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames all overload signatures and the implementation', async () => {
      await renameAndAssert(project, {
        filePath: 'src/parse.ts',
        line: 3,
        oldName: 'parse',
        newName: 'decode',
      });

      const parseContent = await readFile(project, 'src/parse.ts');
      // All three declarations should be renamed
      const decodeMatches = parseContent.match(/\bdecode\b/g);
      expect(decodeMatches).not.toBeNull();
      expect(decodeMatches!.length).toBeGreaterThanOrEqual(3);
      // "parse" should only survive inside JSON.parse (not as a standalone identifier)
      expect(parseContent).not.toMatch(/(?<!JSON\.)\bparse\b/);

      const callerContent = await readFile(project, 'src/caller.ts');
      expect(callerContent).toContain('import { decode }');
      expect(callerContent).toContain('decode("{}")');
    });
  });

  describe('rename from usage site (not definition)', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/lib.ts': [
          'export function compute(x: number) {',
          '  return x * 2;',
          '}',
        ].join('\n'),
        'src/app.ts': [
          'import { compute } from "./lib";',
          '',
          'export const result = compute(5);',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames correctly when targeting a usage site', async () => {
      await renameAndAssert(project, {
        filePath: 'src/app.ts',
        line: 3,
        oldName: 'compute',
        newName: 'calculate',
      });

      expect(await readFile(project, 'src/lib.ts')).toContain('export function calculate(');
      expect(await readFile(project, 'src/lib.ts')).not.toContain('compute');

      const appContent = await readFile(project, 'src/app.ts');
      expect(appContent).toContain('import { calculate }');
      expect(appContent).toContain('calculate(5)');
    });
  });

  describe('same name in comment before identifier on same line', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/tricky.ts': [
          '// A helper: use getValue to read the value',
          'export function getValue() { return 42; }',
        ].join('\n'),
        'src/user.ts': [
          'import { getValue } from "./tricky";',
          'export const v = getValue();',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('skips comment occurrence and targets the actual identifier', async () => {
      // "getValue" appears in the comment on line 1, but the function is on line 2
      await renameAndAssert(project, {
        filePath: 'src/tricky.ts',
        line: 2,
        oldName: 'getValue',
        newName: 'readValue',
      });

      const trickyContent = await readFile(project, 'src/tricky.ts');
      expect(trickyContent).toContain('export function readValue()');
      // Comment should be preserved as-is
      expect(trickyContent).toContain('use getValue to read');

      const userContent = await readFile(project, 'src/user.ts');
      expect(userContent).toContain('import { readValue }');
      expect(userContent).toContain('readValue()');
    });
  });

  describe('multiple same-name identifiers on one line', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/multi.ts': [
          'export const foo = 1; export const useFoo = () => foo;',
        ].join('\n'),
        'src/user.ts': [
          'import { foo } from "./multi";',
          'console.log(foo);',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames the correct identifier when multiple appear on one line', async () => {
      await renameAndAssert(project, {
        filePath: 'src/multi.ts',
        line: 1,
        oldName: 'foo',
        newName: 'bar',
      });

      const content = await readFile(project, 'src/multi.ts');
      expect(content).toContain('const bar = 1');
      expect(content).toContain('() => bar');
      // useFoo should NOT be affected (it's a different identifier)
      expect(content).toContain('useFoo');

      const userContent = await readFile(project, 'src/user.ts');
      expect(userContent).toContain('import { bar }');
      expect(userContent).toContain('console.log(bar)');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Error handling
  // ═══════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/exists.ts': 'export const x = 1;\n',
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('returns not_found when symbol is not on the specified line', async () => {
      const result = await tsMorphRename({
        repoPath: project.root,
        filePath: 'src/exists.ts',
        line: 1,
        oldName: 'nonExistent',
        newName: 'whatever',
        dryRun: true,
      });
      expect(result.status).toBe('not_found');
    });

    it('returns not_found when line number exceeds file length', async () => {
      const result = await tsMorphRename({
        repoPath: project.root,
        filePath: 'src/exists.ts',
        line: 999,
        oldName: 'x',
        newName: 'y',
        dryRun: true,
      });
      expect(result.status).toBe('not_found');
    });

    it('returns not_found for a non-existent file (ENOENT)', async () => {
      const result = await tsMorphRename({
        repoPath: project.root,
        filePath: 'src/missing.ts',
        line: 1,
        oldName: 'foo',
        newName: 'bar',
        dryRun: true,
      });
      expect(result.status).toBe('not_found');
    });

    it('throws on invalid line number (< 1)', async () => {
      await expect(
        tsMorphRename({
          repoPath: project.root,
          filePath: 'src/exists.ts',
          line: 0,
          oldName: 'x',
          newName: 'y',
          dryRun: true,
        }),
      ).rejects.toThrow(/Invalid line number/);
    });

    it('throws on negative line number', async () => {
      await expect(
        tsMorphRename({
          repoPath: project.root,
          filePath: 'src/exists.ts',
          line: -5,
          oldName: 'x',
          newName: 'y',
          dryRun: true,
        }),
      ).rejects.toThrow(/Invalid line number/);
    });

    it('throws on empty oldName', async () => {
      await expect(
        tsMorphRename({
          repoPath: project.root,
          filePath: 'src/exists.ts',
          line: 1,
          oldName: '',
          newName: 'y',
          dryRun: true,
        }),
      ).rejects.toThrow(/oldName is required/);
    });

    it('throws on empty newName', async () => {
      await expect(
        tsMorphRename({
          repoPath: project.root,
          filePath: 'src/exists.ts',
          line: 1,
          oldName: 'x',
          newName: '',
          dryRun: true,
        }),
      ).rejects.toThrow(/newName is required/);
    });

    it('does not swallow permission errors on file access', async () => {
      // Create a file and remove read permissions
      const noReadFile = path.join(project.root, 'src', 'no-read.ts');
      await fs.writeFile(noReadFile, 'export const secret = 1;\n');
      await fs.chmod(noReadFile, 0o000);

      try {
        // Should throw EACCES, not return null
        await expect(
          tsMorphRename({
            repoPath: project.root,
            filePath: 'src/no-read.ts',
            line: 1,
            oldName: 'secret',
            newName: 'hidden',
            dryRun: true,
          }),
        ).rejects.toThrow(); // EACCES or similar
      } finally {
        // Restore permissions for cleanup
        await fs.chmod(noReadFile, 0o644);
      }
    });
  });

  describe('edit format correctness', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/fmt.ts': [
          'export function myFunc(a: number) {',
          '  return a;',
          '}',
        ].join('\n'),
        'src/use.ts': [
          'import { myFunc } from "./fmt";',
          'export const r = myFunc(1);',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('every edit has correct old_text and new_text for its line', async () => {
      const edits = await renameAndAssert(project, {
        filePath: 'src/fmt.ts',
        line: 1,
        oldName: 'myFunc',
        newName: 'fn',
        dryRun: true,
      });

      for (const edit of edits) {
        // old_text must contain oldName, new_text must contain newName
        expect(edit.old_text).toContain('myFunc');
        expect(edit.new_text).toContain('fn');
        // new_text should be old_text with the substitution
        expect(edit.new_text).toBe(edit.old_text.replace('myFunc', 'fn'));
        // line numbers must be positive integers
        expect(Number.isInteger(edit.line)).toBe(true);
        expect(edit.line).toBeGreaterThan(0);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Interface member rename (semantic, not text-based)
  // ═══════════════════════════════════════════════════════════════════════

  describe('interface member rename — semantic (regression test)', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/types.ts': [
          'export interface JobRecord {',
          '    sourceId: number;',
          '    destBuilding: number;  // interface field',
          '}',
        ].join('\n'),
        'src/service.ts': [
          'import type { JobRecord } from "./types";',
          '',
          '// Local variable with same name — should NOT be renamed',
          'function resolveDestination(destBuilding: number) {',
          '    const entity = getEntity(destBuilding);',
          '    return entity;',
          '}',
          '',
          'export function createJob(record: JobRecord) {',
          '    // Property access — should be renamed',
          '    const dest = record.destBuilding;',
          '    return { dest };',
          '}',
        ].join('\n'),
        'src/store.ts': [
          'import type { JobRecord } from "./types";',
          '',
          'export function findByDest(jobs: JobRecord[], id: number) {',
          '    // Property access in filter — should be renamed',
          '    return jobs.filter(j => j.destBuilding === id);',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames interface property but not local variables with same name', async () => {
      // Line 3 is where "destBuilding: number;" is defined in types.ts
      const edits = await renameAndAssert(project, {
        filePath: 'src/types.ts',
        line: 3,
        oldName: 'destBuilding',
        newName: 'destBuildingId',
      });

      // Verify interface definition is renamed
      const typesContent = await readFile(project, 'src/types.ts');
      expect(typesContent).toContain('destBuildingId: number;');
      expect(typesContent).not.toContain('destBuilding:');

      // Verify property accesses are renamed
      const serviceContent = await readFile(project, 'src/service.ts');
      expect(serviceContent).toContain('record.destBuildingId');
      // Use regex to check for old name not followed by 'Id' (avoid substring match)
      expect(serviceContent).not.toMatch(/record\.destBuilding(?!Id)/);

      const storeContent = await readFile(project, 'src/store.ts');
      expect(storeContent).toContain('j.destBuildingId');
      expect(storeContent).not.toMatch(/j\.destBuilding(?!Id)/);

      // CRITICAL: Local variables with same name must NOT be renamed
      // These are semantically different from the interface property
      expect(serviceContent).toContain('function resolveDestination(destBuilding: number)');
      expect(serviceContent).toContain('getEntity(destBuilding)');
      expect(serviceContent).not.toContain('destBuildingId: number)'); // param should NOT be renamed

      // Verify edit count — should only touch interface + property accesses, not local vars
      // Expected: types.ts:1 + service.ts:1 + store.ts:1 = 3 edits minimum
      // Should NOT be 6+ (which would include local var renames)
      expect(edits.length).toBeLessThanOrEqual(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Shorthand property expansion during interface rename
  // ═══════════════════════════════════════════════════════════════════════

  describe('shorthand property expansion (regression test)', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/types.ts': [
          'export interface TransportJobRecord {',
          '    sourceId: number;',
          '    destBuilding: number;',
          '}',
        ].join('\n'),
        'src/factory.ts': [
          'import type { TransportJobRecord } from "./types";',
          '',
          '// Function with parameter named destBuilding — same name as interface property',
          'export function createDeliveryOnlyRecord(',
          '    sourceId: number,',
          '    destBuilding: number,',
          '): TransportJobRecord {',
          '    // Shorthand property syntax: { destBuilding } means { destBuilding: destBuilding }',
          '    // When renaming the interface property, we must expand this to explicit syntax',
          '    return {',
          '        sourceId,',
          '        destBuilding,  // shorthand — variable destBuilding still exists',
          '    };',
          '}',
        ].join('\n'),
        'src/consumer.ts': [
          'import type { TransportJobRecord } from "./types";',
          '',
          'export function readBuilding(record: TransportJobRecord): number {',
          '    // Property access — should be renamed',
          '    return record.destBuilding;',
          '}',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('expands shorthand property when renaming interface field', async () => {
      // Rename the interface property destBuilding → destBuildingId
      const edits = await renameAndAssert(project, {
        filePath: 'src/types.ts',
        line: 3,
        oldName: 'destBuilding',
        newName: 'destBuildingId',
      });

      // Verify interface definition is renamed
      const typesContent = await readFile(project, 'src/types.ts');
      expect(typesContent).toContain('destBuildingId: number;');
      expect(typesContent).not.toMatch(/\bdestBuilding:/);

      // CRITICAL: Shorthand must be expanded, not broken
      // Before: { destBuilding }  (shorthand for { destBuilding: destBuilding })
      // After:  { destBuildingId: destBuilding }  (expanded with new key, old variable)
      const factoryContent = await readFile(project, 'src/factory.ts');

      // The parameter must NOT be renamed (it's a different symbol)
      expect(factoryContent).toContain('destBuilding: number,');

      // The shorthand must be expanded to explicit syntax with the new property name
      // and the old variable reference preserved
      expect(factoryContent).toContain('destBuildingId: destBuilding');

      // Must NOT have broken shorthand { destBuildingId } (no such variable exists)
      expect(factoryContent).not.toMatch(/{\s*[^}]*\bdestBuildingId\s*,/);
      expect(factoryContent).not.toMatch(/,\s*destBuildingId\s*[,}]/);

      // Property access in consumer should be renamed normally
      const consumerContent = await readFile(project, 'src/consumer.ts');
      expect(consumerContent).toContain('record.destBuildingId');

      // Verify edits include the expanded shorthand
      const factoryEdit = edits.find((e) => e.filePath === 'src/factory.ts');
      expect(factoryEdit).toBeDefined();
      expect(factoryEdit!.new_text).toContain('destBuildingId: destBuilding');
    });

    it('preview (dry-run) shows correct expanded shorthand', async () => {
      // Create a fresh project for dry-run test
      const dryRunProject = await createTempProject({
        'src/types.ts': [
          'export interface Record {',
          '    field: number;',
          '}',
        ].join('\n'),
        'src/builder.ts': [
          'import type { Record } from "./types";',
          '',
          'export function build(field: number): Record {',
          '    return { field };  // shorthand',
          '}',
        ].join('\n'),
      });

      try {
        const result = await tsMorphRename({
          repoPath: dryRunProject.root,
          filePath: 'src/types.ts',
          line: 2,
          oldName: 'field',
          newName: 'fieldId',
          dryRun: true,
        });

        expect(result.status).toBe('success');
        if (result.status !== 'success') throw new Error('Expected success');
        expect(result.edits.length).toBeGreaterThan(0);

        // Find the builder.ts edit
        const builderEdit = result.edits.find((e) => e.filePath === 'src/builder.ts');
        expect(builderEdit).toBeDefined();

        // Dry-run preview must show the expanded form
        expect(builderEdit!.old_text).toContain('{ field }');
        expect(builderEdit!.new_text).toContain('fieldId: field');

        // Verify file was NOT modified (dry run)
        const builderContent = await readFile(dryRunProject, 'src/builder.ts');
        expect(builderContent).toContain('{ field }');
        expect(builderContent).not.toContain('fieldId');
      } finally {
        await dryRunProject.cleanup();
      }
    });
  });

});
