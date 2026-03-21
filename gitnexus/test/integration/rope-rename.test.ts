/**
 * Integration Tests: rope rename
 *
 * Tests the Python rope-powered rename against real filesystem Python
 * projects. Each test creates a temp directory with Python source files,
 * then verifies that ropeRename produces scope-aware, semantically
 * correct edits.
 *
 * Requires: Python 3 with `rope` installed (pip install rope).
 *
 * Categories:
 * 1. Basic rename behavior (dry run, apply, edit format)
 * 2. Scope awareness (locals, closures, shadowing)
 * 3. Import patterns (from-import, import-as, __init__ re-exports)
 * 4. Class features (methods, inheritance, properties)
 * 5. Advanced patterns (decorators, comprehensions, string preservation)
 * 6. Error handling (missing files, invalid inputs, propagation)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ropeRename, isPythonFile } from '../../src/core/rename/rope-rename.js';

// ─── Helpers ────────────────────────────────────────────────────────────

interface TempProject {
  root: string;
  cleanup: () => Promise<void>;
}

/** Create a temp directory with Python source files. */
async function createTempProject(files: Record<string, string>): Promise<TempProject> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rope-rename-'));

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
  const edits = await ropeRename({
    repoPath: project.root,
    dryRun: opts.dryRun ?? false,
    ...opts,
  });
  expect(edits).not.toBeNull();
  expect(edits!.length).toBeGreaterThan(0);
  for (const edit of edits!) {
    expect(edit.confidence).toBe('rope');
    expect(edit.line).toBeGreaterThan(0);
    expect(edit.filePath).toBeTruthy();
  }
  return edits!;
}

// ─── Check rope availability ────────────────────────────────────────────

let ropeAvailable = true;

beforeAll(async () => {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('python3', ['-c', 'import rope'], { timeout: 5000 });
  } catch {
    ropeAvailable = false;
    console.warn('Skipping rope-rename tests: Python 3 with rope not available');
  }
});

// ─── isPythonFile ───────────────────────────────────────────────────────

describe('isPythonFile', () => {
  it.each([
    ['file.py', true],
    ['file.pyw', true],
    ['file.pyi', true],
    ['file.ts', false],
    ['file.js', false],
    ['file.rb', false],
    ['file', false],
  ])('%s → %s', (file, expected) => {
    expect(isPythonFile(file)).toBe(expected);
  });
});

// ─── ropeRename ─────────────────────────────────────────────────────────

describe.runIf(ropeAvailable)('ropeRename', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Basic rename
  // ═══════════════════════════════════════════════════════════════════════

  describe('basic function rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'math_utils.py': [
          'def calculate_sum(a, b):',
          '    return a + b',
          '',
          '',
          'def multiply(a, b):',
          '    return calculate_sum(a, 0) + a * b',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('finds all references in dry run without modifying files', async () => {
      const edits = await renameAndAssert(project, {
        filePath: 'math_utils.py',
        line: 1,
        oldName: 'calculate_sum',
        newName: 'add',
        dryRun: true,
      });

      expect(edits.length).toBeGreaterThanOrEqual(2);

      // Dry run must NOT modify files
      const content = await readFile(project, 'math_utils.py');
      expect(content).toContain('calculate_sum');
    });

    it('applies rename when dryRun is false', async () => {
      const edits = await renameAndAssert(project, {
        filePath: 'math_utils.py',
        line: 1,
        oldName: 'calculate_sum',
        newName: 'add',
      });

      expect(edits.length).toBeGreaterThanOrEqual(2);

      const content = await readFile(project, 'math_utils.py');
      expect(content).toContain('def add(a, b):');
      expect(content).toContain('return add(a, 0)');
      expect(content).not.toContain('calculate_sum');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Scope awareness
  // ═══════════════════════════════════════════════════════════════════════

  describe('scope awareness: local vs global', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'scopes.py': [
          'def process(data):',
          '    return data.strip()',
          '',
          '',
          'def handler():',
          '    process = lambda x: x * 2',
          '    return process(42)',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames global function without touching shadowed local', async () => {
      await renameAndAssert(project, {
        filePath: 'scopes.py',
        line: 1,
        oldName: 'process',
        newName: 'transform',
      });

      const content = await readFile(project, 'scopes.py');
      expect(content).toContain('def transform(data):');
      // The local lambda should NOT be renamed
      expect(content).toContain('process = lambda x: x * 2');
      expect(content).toContain('return process(42)');
    });
  });

  describe('scope awareness: closure capture', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'closure.py': [
          'def make_counter():',
          '    value = 0',
          '    def increment():',
          '        nonlocal value',
          '        value += 1',
          '    def get():',
          '        return value',
          '    return increment, get',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames captured variable through closures', async () => {
      await renameAndAssert(project, {
        filePath: 'closure.py',
        line: 2,
        oldName: 'value',
        newName: 'count',
      });

      const content = await readFile(project, 'closure.py');
      expect(content).toContain('count = 0');
      expect(content).toContain('nonlocal count');
      expect(content).toContain('count += 1');
      expect(content).toContain('return count');
      expect(content).not.toMatch(/\bvalue\b/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Import patterns
  // ═══════════════════════════════════════════════════════════════════════

  describe('cross-file from-import', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/__init__.py': '',
        'src/core.py': [
          'def validate_email(email):',
          '    return "@" in email',
        ].join('\n'),
        'src/consumer.py': [
          'from src.core import validate_email',
          '',
          '',
          'def check_user(email):',
          '    if not validate_email(email):',
          '        raise ValueError("Invalid email")',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates definition and import', async () => {
      const edits = await renameAndAssert(project, {
        filePath: 'src/core.py',
        line: 1,
        oldName: 'validate_email',
        newName: 'is_valid_email',
      });

      const files = new Set(edits.map(e => e.filePath));
      expect(files).toContain('src/core.py');
      expect(files).toContain('src/consumer.py');

      expect(await readFile(project, 'src/core.py')).toContain('def is_valid_email(email):');

      const consumerContent = await readFile(project, 'src/consumer.py');
      expect(consumerContent).toContain('from src.core import is_valid_email');
      expect(consumerContent).toContain('if not is_valid_email(email):');
    });
  });

  describe('import alias', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'src/__init__.py': '',
        'src/lib.py': [
          'def fetch_data(url):',
          '    return url',
        ].join('\n'),
        'src/app.py': [
          'from src.lib import fetch_data as get_data',
          '',
          'result = get_data("/api")',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames the original function; alias stays unchanged', async () => {
      await renameAndAssert(project, {
        filePath: 'src/lib.py',
        line: 1,
        oldName: 'fetch_data',
        newName: 'request_data',
      });

      expect(await readFile(project, 'src/lib.py')).toContain('def request_data(url):');

      const appContent = await readFile(project, 'src/app.py');
      expect(appContent).toContain('from src.lib import request_data as get_data');
      // The alias must NOT change
      expect(appContent).toContain('get_data("/api")');
    });
  });

  describe('__init__.py re-export', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'pkg/__init__.py': 'from pkg.core import compute\n',
        'pkg/core.py': [
          'def compute(x):',
          '    return x * 2',
        ].join('\n'),
        'app.py': [
          'from pkg import compute',
          '',
          'print(compute(5))',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('updates definition, __init__ re-export, and consumer', async () => {
      const edits = await renameAndAssert(project, {
        filePath: 'pkg/core.py',
        line: 1,
        oldName: 'compute',
        newName: 'calculate',
      });

      const files = new Set(edits.map(e => e.filePath));
      expect(files).toContain('pkg/core.py');
      expect(files).toContain('pkg/__init__.py');
      expect(files).toContain('app.py');

      expect(await readFile(project, 'pkg/core.py')).toContain('def calculate(x):');
      expect(await readFile(project, 'pkg/__init__.py')).toContain('from pkg.core import calculate');
      expect(await readFile(project, 'app.py')).toContain('from pkg import calculate');
      expect(await readFile(project, 'app.py')).toContain('calculate(5)');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Class features
  // ═══════════════════════════════════════════════════════════════════════

  describe('class rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'models.py': [
          'class UserProfile:',
          '    def __init__(self, name):',
          '        self.name = name',
        ].join('\n'),
        'app.py': [
          'from models import UserProfile',
          '',
          'profile = UserProfile("test")',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames class in definition, import, and instantiation', async () => {
      await renameAndAssert(project, {
        filePath: 'models.py',
        line: 1,
        oldName: 'UserProfile',
        newName: 'PersonProfile',
      });

      expect(await readFile(project, 'models.py')).toContain('class PersonProfile:');

      const appContent = await readFile(project, 'app.py');
      expect(appContent).toContain('from models import PersonProfile');
      expect(appContent).toContain('PersonProfile("test")');
      expect(appContent).not.toContain('UserProfile');
    });
  });

  describe('method rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'service.py': [
          'class UserService:',
          '    def fetch_user(self, user_id):',
          '        return {"id": user_id}',
          '',
          '    def delete_user(self, user_id):',
          '        user = self.fetch_user(user_id)',
          '        return user',
        ].join('\n'),
        'handler.py': [
          'from service import UserService',
          '',
          'svc = UserService()',
          'user = svc.fetch_user("123")',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames method in definition, self-calls, and external usage', async () => {
      await renameAndAssert(project, {
        filePath: 'service.py',
        line: 2,
        oldName: 'fetch_user',
        newName: 'get_user',
      });

      const serviceContent = await readFile(project, 'service.py');
      expect(serviceContent).toContain('def get_user(self, user_id):');
      expect(serviceContent).toContain('self.get_user(user_id)');
      expect(serviceContent).not.toContain('fetch_user');

      expect(await readFile(project, 'handler.py')).toContain('svc.get_user("123")');
    });
  });

  describe('class inheritance', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'base.py': [
          'class BaseLogger:',
          '    def log(self, msg):',
          '        print(msg)',
        ].join('\n'),
        'child.py': [
          'from base import BaseLogger',
          '',
          '',
          'class AppLogger(BaseLogger):',
          '    def error(self, msg):',
          '        super().log(f"ERROR: {msg}")',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames base class across inheritance chain', async () => {
      await renameAndAssert(project, {
        filePath: 'base.py',
        line: 1,
        oldName: 'BaseLogger',
        newName: 'CoreLogger',
      });

      expect(await readFile(project, 'base.py')).toContain('class CoreLogger:');

      const childContent = await readFile(project, 'child.py');
      expect(childContent).toContain('from base import CoreLogger');
      expect(childContent).toContain('class AppLogger(CoreLogger):');
      expect(childContent).not.toContain('BaseLogger');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Advanced patterns
  // ═══════════════════════════════════════════════════════════════════════

  describe('string literals are preserved', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'utils.py': [
          'def format_date(d):',
          '    """The format_date function formats a date."""',
          '    label = "format_date output"',
          '    return str(d)',
          '',
          '',
          'result = format_date("2024-01-01")',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames identifiers but preserves string contents', async () => {
      await renameAndAssert(project, {
        filePath: 'utils.py',
        line: 1,
        oldName: 'format_date',
        newName: 'to_date_string',
      });

      const content = await readFile(project, 'utils.py');
      expect(content).toContain('def to_date_string(d):');
      expect(content).toContain('to_date_string("2024-01-01")');
      // String literal must NOT be renamed
      expect(content).toContain('"format_date output"');
    });
  });

  describe('decorator rename', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'decorators.py': [
          'def log_call(func):',
          '    def wrapper(*args, **kwargs):',
          '        print(f"Calling {func.__name__}")',
          '        return func(*args, **kwargs)',
          '    return wrapper',
          '',
          '',
          '@log_call',
          'def process(data):',
          '    return data',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames decorator function in definition and @usage', async () => {
      await renameAndAssert(project, {
        filePath: 'decorators.py',
        line: 1,
        oldName: 'log_call',
        newName: 'trace',
      });

      const content = await readFile(project, 'decorators.py');
      expect(content).toContain('def trace(func):');
      expect(content).toContain('@trace');
      expect(content).not.toMatch(/\blog_call\b/);
    });
  });

  describe('variable in comprehension', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'data.py': [
          'items = [1, 2, 3, 4, 5]',
          'doubled = [item * 2 for item in items]',
          'total = sum(items)',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames module-level variable including comprehension refs', async () => {
      await renameAndAssert(project, {
        filePath: 'data.py',
        line: 1,
        oldName: 'items',
        newName: 'numbers',
      });

      const content = await readFile(project, 'data.py');
      expect(content).toContain('numbers = [1, 2, 3, 4, 5]');
      expect(content).toContain('for item in numbers]');
      expect(content).toContain('sum(numbers)');
      // 'item' (loop variable) must NOT be renamed
      expect(content).toContain('item * 2');
    });
  });

  describe('rename from usage site', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'lib.py': [
          'def compute(x):',
          '    return x * 2',
        ].join('\n'),
        'app.py': [
          'from lib import compute',
          '',
          'result = compute(5)',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('renames correctly when targeting a usage site', async () => {
      await renameAndAssert(project, {
        filePath: 'app.py',
        line: 3,
        oldName: 'compute',
        newName: 'calculate',
      });

      expect(await readFile(project, 'lib.py')).toContain('def calculate(x):');

      const appContent = await readFile(project, 'app.py');
      expect(appContent).toContain('from lib import calculate');
      expect(appContent).toContain('calculate(5)');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Error handling
  // ═══════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'exists.py': 'x = 1\n',
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('returns null when symbol is not on the specified line', async () => {
      const edits = await ropeRename({
        repoPath: project.root,
        filePath: 'exists.py',
        line: 1,
        oldName: 'nonExistent',
        newName: 'whatever',
        dryRun: true,
      });
      expect(edits).toBeNull();
    });

    it('returns null for a non-existent file', async () => {
      const edits = await ropeRename({
        repoPath: project.root,
        filePath: 'missing.py',
        line: 1,
        oldName: 'foo',
        newName: 'bar',
        dryRun: true,
      });
      expect(edits).toBeNull();
    });

    it('throws on invalid line number (< 1)', async () => {
      await expect(
        ropeRename({
          repoPath: project.root,
          filePath: 'exists.py',
          line: 0,
          oldName: 'x',
          newName: 'y',
          dryRun: true,
        }),
      ).rejects.toThrow(/Invalid line number/);
    });

    it('throws on empty oldName', async () => {
      await expect(
        ropeRename({
          repoPath: project.root,
          filePath: 'exists.py',
          line: 1,
          oldName: '',
          newName: 'y',
          dryRun: true,
        }),
      ).rejects.toThrow(/oldName is required/);
    });

    it('throws on empty newName', async () => {
      await expect(
        ropeRename({
          repoPath: project.root,
          filePath: 'exists.py',
          line: 1,
          oldName: 'x',
          newName: '',
          dryRun: true,
        }),
      ).rejects.toThrow(/newName is required/);
    });

    it('throws on Python keyword as new name', async () => {
      await expect(
        ropeRename({
          repoPath: project.root,
          filePath: 'exists.py',
          line: 1,
          oldName: 'x',
          newName: 'class',
          dryRun: true,
        }),
      ).rejects.toThrow();
    });
  });

  describe('edit format correctness', () => {
    let project: TempProject;

    beforeAll(async () => {
      project = await createTempProject({
        'fmt.py': [
          'def my_func(a):',
          '    return a',
          '',
          '',
          'result = my_func(1)',
        ].join('\n'),
      });
    });

    afterAll(async () => { await project.cleanup(); });

    it('every edit has correct old_text and new_text for its line', async () => {
      const edits = await renameAndAssert(project, {
        filePath: 'fmt.py',
        line: 1,
        oldName: 'my_func',
        newName: 'fn',
        dryRun: true,
      });

      for (const edit of edits) {
        expect(edit.old_text).toContain('my_func');
        expect(edit.new_text).toContain('fn');
        expect(edit.new_text).toBe(edit.old_text.replace('my_func', 'fn'));
        expect(Number.isInteger(edit.line)).toBe(true);
        expect(edit.line).toBeGreaterThan(0);
      }
    });
  });

});
