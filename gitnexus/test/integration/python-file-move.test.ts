/**
 * Integration Tests: Python file / package move via rope
 *
 * Verifies that fileRename / directoryRename / ropeMove rewrite Python
 * imports (not just filesystem moves) when rope is available.
 *
 * Requires: Python 3 with `rope` installed (pip install rope).
 *
 * Categories:
 *  1. Dry-run purity
 *  2. Path geometry (same-dir rename, cross-package move, rename+move, deep dest)
 *  3. Import styles (from-import, import-as, star, relative, multi-consumer)
 *  4. Package internals (__init__ re-exports, moved module outward imports)
 *  5. src/ layout + inferred source folders
 *  6. Directory / package renames (sibling, parent change, move+rename, nested, empty)
 *  7. Assets alongside Python
 *  8. Mixed TS + Python directory
 *  9. Non-Python files stay filesystem-only
 * 10. Limitations (string literals, comments)
 * 11. Error handling
 * 12. Edit / response shape
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileRename } from '../../src/core/rename/file-rename.js';
import { directoryRename } from '../../src/core/rename/directory-rename.js';
import { ropeMove, isPythonFile } from '../../src/core/rename/rope-rename.js';

// ─── Helpers ────────────────────────────────────────────────────────────

interface TempProject {
  root: string;
  cleanup: () => Promise<void>;
}

async function createTempProject(files: Record<string, string>): Promise<TempProject> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'python-file-move-'));

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  return {
    root,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function readFile(project: TempProject, filePath: string): Promise<string> {
  return fs.readFile(path.join(project.root, filePath), 'utf-8');
}

async function fileExists(project: TempProject, filePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(project.root, filePath));
    return true;
  } catch {
    return false;
  }
}

async function snapshot(project: TempProject): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, rel = ''): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, r);
      else out[r] = await fs.readFile(full, 'utf-8');
    }
  }
  await walk(project.root);
  return out;
}

function pkgHelpersProject(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'pkg/__init__.py': '',
    'other/__init__.py': '',
    'pkg/helpers.py': ['def format_val(x):', '    return str(x)'].join('\n'),
    ...extra,
  };
}

// ─── Rope availability ──────────────────────────────────────────────────

let ropeAvailable = true;

beforeAll(async () => {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('python3', ['-c', 'import rope'], { timeout: 5000 });
  } catch {
    ropeAvailable = false;
    console.warn('Skipping python-file-move tests: Python 3 with rope not available');
  }
});

// ─── isPythonFile (no rope needed) ──────────────────────────────────────

describe('isPythonFile', () => {
  it.each([
    ['mod.py', true],
    ['mod.pyw', true],
    ['mod.pyi', true],
    ['mod.ts', false],
    ['mod.css', false],
    ['mod', false],
  ])('%s → %s', (file, expected) => {
    expect(isPythonFile(file)).toBe(expected);
  });
});

// ─── Suite ──────────────────────────────────────────────────────────────

describe.runIf(ropeAvailable)('Python file/package move (rope)', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // 1. Dry-run purity
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. dry-run purity (must never mutate the real tree)', () => {
    let project: TempProject;
    let before: Record<string, string>;

    beforeAll(async () => {
      project = await createTempProject(
        pkgHelpersProject({
          'app.py': 'from pkg.helpers import format_val\n',
          'pkg/consumer.py': 'from .helpers import format_val\n',
        }),
      );
      before = await snapshot(project);
    });

    afterAll(async () => {
      await project.cleanup();
    });

    it('previews import rewrites and files_moved without touching the tree', async () => {
      const result = await ropeMove({
        repoPath: project.root,
        oldPath: 'pkg/helpers.py',
        newPath: 'other/helpers.py',
        dryRun: true,
      });

      expect(result.files_moved).toEqual([{ from: 'pkg/helpers.py', to: 'other/helpers.py' }]);
      expect(result.edits.length).toBeGreaterThan(0);
      expect(result.edits.every((e) => e.confidence === 'rope')).toBe(true);

      const appEdit = result.edits.find((e) => e.filePath === 'app.py');
      expect(appEdit?.old_text).toContain('pkg.helpers');
      expect(appEdit?.new_text).toContain('other.helpers');

      expect(await snapshot(project)).toEqual(before);
    });

    it('fileRename dryRun also leaves the tree unchanged', async () => {
      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: true,
      });
      expect(result.edits.length).toBeGreaterThan(0);
      expect(await snapshot(project)).toEqual(before);
    });

    it('directoryRename dryRun leaves package tree unchanged', async () => {
      const pkgProject = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/canvas/__init__.py': 'from .draw import draw\n',
        'pkg/canvas/draw.py': 'def draw():\n    return 1\n',
        'app.py': 'from pkg.canvas.draw import draw\n',
      });
      const snap = await snapshot(pkgProject);

      const result = await directoryRename({
        repoPath: pkgProject.root,
        oldDir: 'pkg/canvas',
        newDir: 'pkg/view',
        dryRun: true,
      });

      expect(result.edits.some((e) => e.new_text.includes('pkg.view'))).toBe(true);
      expect(await snapshot(pkgProject)).toEqual(snap);
      await pkgProject.cleanup();
    });

    it('dry-run does not create missing destination parents on the real tree', async () => {
      const p = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/helpers.py': 'def f():\n    return 1\n',
        'app.py': 'from pkg.helpers import f\n',
      });
      const snap = await snapshot(p);

      const result = await ropeMove({
        repoPath: p.root,
        oldPath: 'pkg/helpers.py',
        newPath: 'brand/new/package/helpers.py',
        dryRun: true,
      });

      expect(result.edits.length).toBeGreaterThan(0);
      expect(await fileExists(p, 'brand/new/package/helpers.py')).toBe(false);
      expect(await fileExists(p, 'brand')).toBe(false);
      expect(await snapshot(p)).toEqual(snap);
      await p.cleanup();
    });

    it('dry-run rename+move does not leave intermediate renames on the real tree', async () => {
      const p = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/helpers.py': 'def f():\n    return 1\n',
        'app.py': 'from pkg.helpers import f\n',
      });
      const snap = await snapshot(p);

      await ropeMove({
        repoPath: p.root,
        oldPath: 'pkg/helpers.py',
        newPath: 'lib/formatters.py',
        dryRun: true,
      });

      // Intermediate rename would be pkg/formatters.py if apply-then-undo leaked
      expect(await fileExists(p, 'pkg/formatters.py')).toBe(false);
      expect(await fileExists(p, 'lib/formatters.py')).toBe(false);
      expect(await fileExists(p, 'pkg/helpers.py')).toBe(true);
      expect(await snapshot(p)).toEqual(snap);
      await p.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Path geometry
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. path geometry', () => {
    it('renames module in place (same parent, new basename)', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/helpers.py': 'def f():\n    return 1\n',
        'app.py': 'from pkg.helpers import f\n',
      });

      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'pkg/formatters.py',
        dryRun: false,
      });

      expect(await fileExists(project, 'pkg/formatters.py')).toBe(true);
      expect(await fileExists(project, 'pkg/helpers.py')).toBe(false);
      expect(await readFile(project, 'app.py')).toContain('from pkg.formatters import f');
      expect(result.edits.every((e) => e.confidence === 'rope')).toBe(true);
      await project.cleanup();
    });

    it('moves module across packages (new parent, same basename)', async () => {
      const project = await createTempProject(
        pkgHelpersProject({
          'app.py': 'from pkg.helpers import format_val\n',
        }),
      );

      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });

      expect(await fileExists(project, 'other/helpers.py')).toBe(true);
      expect(await fileExists(project, 'pkg/helpers.py')).toBe(false);
      expect(await readFile(project, 'app.py')).toContain('from other.helpers import format_val');
      await project.cleanup();
    });

    it('renames and moves in one step (new parent + new basename)', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/helpers.py': 'def f():\n    return 1\n',
        'app.py': 'from pkg.helpers import f\n',
      });

      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'lib/formatters.py',
        dryRun: false,
      });

      expect(await fileExists(project, 'lib/formatters.py')).toBe(true);
      expect(await fileExists(project, 'pkg/helpers.py')).toBe(false);
      expect(await readFile(project, 'app.py')).toContain('from lib.formatters import f');
      await project.cleanup();
    });

    it('moves into a pre-existing nested package path', async () => {
      // Destination parents already exist as packages so rope can form pkg.deep.nested.helpers
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/deep/__init__.py': '',
        'pkg/deep/nested/__init__.py': '',
        'pkg/helpers.py': 'def f():\n    return 1\n',
        'app.py': 'from pkg.helpers import f\n',
      });

      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'pkg/deep/nested/helpers.py',
        dryRun: false,
      });

      expect(await fileExists(project, 'pkg/deep/nested/helpers.py')).toBe(true);
      expect(await fileExists(project, 'pkg/helpers.py')).toBe(false);
      expect(await readFile(project, 'app.py')).toContain('from pkg.deep.nested.helpers import f');
      await project.cleanup();
    });

    it('moves between sibling subpackages', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/a/__init__.py': '',
        'pkg/b/__init__.py': '',
        'pkg/a/helpers.py': 'def f():\n    return 1\n',
        'pkg/a/consumer.py': 'from .helpers import f\n',
        'app.py': 'from pkg.a.helpers import f\n',
      });

      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/a/helpers.py',
        newFile: 'pkg/b/helpers.py',
        dryRun: false,
      });

      expect(await readFile(project, 'app.py')).toContain('from pkg.b.helpers import f');
      expect(await readFile(project, 'pkg/a/consumer.py')).toContain('from pkg.b.helpers import f');
      expect(await fileExists(project, 'pkg/b/helpers.py')).toBe(true);
      await project.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Import styles
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. import styles', () => {
    it('rewrites "from pkg.mod import name"', async () => {
      const project = await createTempProject(
        pkgHelpersProject({ 'app.py': 'from pkg.helpers import format_val\n' }),
      );
      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });
      expect(await readFile(project, 'app.py')).toBe('from other.helpers import format_val\n');
      await project.cleanup();
    });

    it('rewrites "import pkg.mod as alias" and keeps the alias', async () => {
      const project = await createTempProject(
        pkgHelpersProject({
          'app.py': 'import pkg.helpers as h\nprint(h.format_val(1))\n',
        }),
      );
      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });
      const app = await readFile(project, 'app.py');
      expect(app).toContain('import other.helpers as h');
      expect(app).toContain('h.format_val(1)');
      await project.cleanup();
    });

    it('rewrites star imports', async () => {
      const project = await createTempProject(
        pkgHelpersProject({ 'app.py': 'from pkg.helpers import *\n' }),
      );
      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });
      expect(await readFile(project, 'app.py')).toBe('from other.helpers import *\n');
      await project.cleanup();
    });

    it('rewrites relative imports in sibling modules', async () => {
      const project = await createTempProject(
        pkgHelpersProject({
          'pkg/consumer.py': 'from .helpers import format_val\n',
        }),
      );
      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });
      expect(await readFile(project, 'pkg/consumer.py')).toContain(
        'from other.helpers import format_val',
      );
      await project.cleanup();
    });

    it('rewrites from-import with alias', async () => {
      const project = await createTempProject(
        pkgHelpersProject({
          'app.py': 'from pkg.helpers import format_val as fv\n',
        }),
      );
      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });
      expect(await readFile(project, 'app.py')).toContain(
        'from other.helpers import format_val as fv',
      );
      await project.cleanup();
    });

    it('updates multiple consumers at different depths', async () => {
      const project = await createTempProject(
        pkgHelpersProject({
          'a.py': 'from pkg.helpers import format_val\n',
          'sub/__init__.py': '',
          'sub/b.py': 'from pkg.helpers import format_val as fv\n',
        }),
      );
      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });

      expect(result.edits.filter((e) => e.filePath === 'a.py' || e.filePath === 'sub/b.py').length).toBeGreaterThanOrEqual(2);
      expect(await readFile(project, 'a.py')).toContain('other.helpers');
      expect(await readFile(project, 'sub/b.py')).toContain('other.helpers');
      await project.cleanup();
    });

    it('moves a module with no importers (files_moved only, zero edits)', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/lonely.py': 'def f():\n    return 1\n',
      });
      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/lonely.py',
        newFile: 'other/lonely.py',
        dryRun: false,
      });
      expect(result.files_moved).toContainEqual({ from: 'pkg/lonely.py', to: 'other/lonely.py' });
      expect(result.edits).toEqual([]);
      expect(await fileExists(project, 'other/lonely.py')).toBe(true);
      await project.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Package internals
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. package internals', () => {
    it('updates __init__ re-exports when a submodule moves out', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': 'from .helpers import format_val\n',
        'other/__init__.py': '',
        'pkg/helpers.py': 'def format_val(x):\n    return str(x)\n',
        'app.py': 'from pkg import format_val\n',
      });

      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });

      expect(await readFile(project, 'pkg/__init__.py')).toContain(
        'from other.helpers import format_val',
      );
      // Barrel import `from pkg import format_val` still valid via updated re-export
      expect(await readFile(project, 'app.py')).toContain('from pkg import format_val');
      await project.cleanup();
    });

    it("adjusts the moved module's own outward relative imports", async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'other/__init__.py': '',
        'pkg/util.py': 'def u():\n    return 1\n',
        'pkg/helpers.py': 'from .util import u\n\ndef f():\n    return u()\n',
        'app.py': 'from pkg.helpers import f\n',
      });

      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });

      const moved = await readFile(project, 'other/helpers.py');
      expect(moved).toContain('from pkg.util import u');
      expect(moved).not.toContain('from .util import u');
      expect(await readFile(project, 'app.py')).toContain('from other.helpers import f');
      await project.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. src/ layout
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. src/ layout (inferred source folders)', () => {
    it('rewrites imports under src/ without __init__.py packages', async () => {
      const project = await createTempProject({
        'src/utils/helpers.py': 'def f():\n    return 1\n',
        'src/app.py': 'from utils.helpers import f\n',
      });

      // Infer source_folders=['src'] inside rope-move.py
      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'src/utils/helpers.py',
        newFile: 'src/lib/helpers.py',
        dryRun: false,
      });

      expect(result.edits.length).toBeGreaterThan(0);
      expect(await fileExists(project, 'src/lib/helpers.py')).toBe(true);
      expect(await readFile(project, 'src/app.py')).toContain('from lib.helpers import f');
      await project.cleanup();
    });

    it('honors explicit sourceFolders on ropeMove', async () => {
      const project = await createTempProject({
        'src/utils/helpers.py': 'def f():\n    return 1\n',
        'src/app.py': 'from utils.helpers import f\n',
      });

      await ropeMove({
        repoPath: project.root,
        oldPath: 'src/utils/helpers.py',
        newPath: 'src/core/helpers.py',
        dryRun: false,
        sourceFolders: ['src'],
      });

      expect(await readFile(project, 'src/app.py')).toContain('from core.helpers import f');
      await project.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Directory / package renames
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. directory / package renames', () => {
    it('renames a sibling package (same parent)', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/canvas/__init__.py': 'from .draw import draw\n',
        'pkg/canvas/draw.py': 'def draw():\n    return 1\n',
        'app.py': 'from pkg.canvas.draw import draw\n',
      });

      await directoryRename({
        repoPath: project.root,
        oldDir: 'pkg/canvas',
        newDir: 'pkg/view',
        dryRun: false,
      });

      expect(await fileExists(project, 'pkg/view/draw.py')).toBe(true);
      expect(await fileExists(project, 'pkg/canvas/draw.py')).toBe(false);
      expect(await readFile(project, 'app.py')).toContain('from pkg.view.draw import draw');
      await project.cleanup();
    });

    it('moves a package under a different parent', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'other/__init__.py': '',
        'pkg/canvas/__init__.py': 'from .draw import draw\n',
        'pkg/canvas/draw.py': 'def draw():\n    return 1\n',
        'app.py': 'from pkg.canvas.draw import draw\n',
      });

      await directoryRename({
        repoPath: project.root,
        oldDir: 'pkg/canvas',
        newDir: 'other/canvas',
        dryRun: false,
      });

      expect(await readFile(project, 'app.py')).toContain('from other.canvas.draw import draw');
      expect(await fileExists(project, 'other/canvas/draw.py')).toBe(true);
      await project.cleanup();
    });

    it('moves and renames a package in one step', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'other/__init__.py': '',
        'pkg/canvas/__init__.py': 'from .draw import draw\n',
        'pkg/canvas/draw.py': 'def draw():\n    return 1\n',
        'app.py': 'from pkg.canvas.draw import draw\n',
      });

      await directoryRename({
        repoPath: project.root,
        oldDir: 'pkg/canvas',
        newDir: 'other/view',
        dryRun: false,
      });

      expect(await readFile(project, 'app.py')).toContain('from other.view.draw import draw');
      expect(await fileExists(project, 'other/view/draw.py')).toBe(true);
      await project.cleanup();
    });

    it('preserves internal relative imports after package rename', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/canvas/__init__.py': 'from .draw import draw\nfrom .util import u\n',
        'pkg/canvas/draw.py': 'from .util import u\n\ndef draw():\n    return u()\n',
        'pkg/canvas/util.py': 'def u():\n    return 1\n',
        'app.py': 'from pkg.canvas import draw\n',
      });

      await directoryRename({
        repoPath: project.root,
        oldDir: 'pkg/canvas',
        newDir: 'pkg/view',
        dryRun: false,
      });

      expect(await readFile(project, 'pkg/view/draw.py')).toContain('from .util import u');
      expect(await readFile(project, 'pkg/view/__init__.py')).toContain('from .draw import draw');
      expect(await readFile(project, 'app.py')).toContain('from pkg.view import draw');
      await project.cleanup();
    });

    it('renames a deeply nested package path', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/x/__init__.py': '',
        'pkg/x/y/__init__.py': 'from .m import m\n',
        'pkg/x/y/m.py': 'def m():\n    return 1\n',
        'app.py': 'from pkg.x.y.m import m\n',
      });

      await directoryRename({
        repoPath: project.root,
        oldDir: 'pkg/x/y',
        newDir: 'pkg/p/q',
        dryRun: false,
      });

      expect(await readFile(project, 'app.py')).toContain('from pkg.p.q.m import m');
      expect(await fileExists(project, 'pkg/p/q/m.py')).toBe(true);
      await project.cleanup();
    });

    it('renames an empty package (only __init__.py)', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/empty/__init__.py': '# empty package\n',
        'app.py': 'import pkg.empty\n',
      });

      await directoryRename({
        repoPath: project.root,
        oldDir: 'pkg/empty',
        newDir: 'pkg/void',
        dryRun: false,
      });

      expect(await fileExists(project, 'pkg/void/__init__.py')).toBe(true);
      expect(await readFile(project, 'app.py')).toContain('import pkg.void');
      await project.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Assets alongside Python
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. non-Python assets in a Python package tree', () => {
    it('moves README/json with the package and still rewrites imports', async () => {
      const project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/canvas/__init__.py': 'from .draw import draw\n',
        'pkg/canvas/draw.py': 'def draw():\n    return 1\n',
        'pkg/canvas/README.md': '# canvas\n',
        'pkg/canvas/data.json': '{"k": 1}\n',
        'app.py': 'from pkg.canvas.draw import draw\n',
      });

      const result = await directoryRename({
        repoPath: project.root,
        oldDir: 'pkg/canvas',
        newDir: 'pkg/view',
        dryRun: false,
      });

      expect(await fileExists(project, 'pkg/view/README.md')).toBe(true);
      expect(await fileExists(project, 'pkg/view/data.json')).toBe(true);
      expect(await readFile(project, 'pkg/view/README.md')).toBe('# canvas\n');
      expect(await readFile(project, 'app.py')).toContain('pkg.view.draw');
      expect(result.files_moved.some((m) => m.to.endsWith('README.md'))).toBe(true);
      await project.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Mixed TS + Python directory
  // ═══════════════════════════════════════════════════════════════════════

  describe('8. mixed TypeScript + Python directory', () => {
    it('moves both languages; rewrites TS imports via ts-morph and Python via rope', async () => {
      // Proper packages so rope can resolve Python modules in a mixed tree
      const project = await createTempProject({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            allowJs: true,
          },
          include: ['**/*.ts'],
        }),
        'pkg/__init__.py': '',
        'pkg/mixed/__init__.py': '',
        'pkg/mixed/util.ts': 'export function tsHelper() { return 1; }\n',
        'pkg/mixed/helpers.py': 'def py_helper():\n    return 2\n',
        'src/app.ts': 'import { tsHelper } from "../pkg/mixed/util";\n',
        'app.py': 'from pkg.mixed.helpers import py_helper\n',
      });

      const result = await directoryRename({
        repoPath: project.root,
        oldDir: 'pkg/mixed',
        newDir: 'pkg/shared',
        dryRun: false,
      });

      expect(await fileExists(project, 'pkg/shared/util.ts')).toBe(true);
      expect(await fileExists(project, 'pkg/shared/helpers.py')).toBe(true);
      expect(await fileExists(project, 'pkg/mixed/util.ts')).toBe(false);
      expect(await fileExists(project, 'pkg/mixed/helpers.py')).toBe(false);

      const appTs = await readFile(project, 'src/app.ts');
      expect(appTs).toMatch(/pkg\/shared\/util/);
      expect(appTs).not.toMatch(/pkg\/mixed\/util/);

      const appPy = await readFile(project, 'app.py');
      expect(appPy).toContain('from pkg.shared.helpers import py_helper');
      expect(appPy).not.toContain('pkg.mixed.helpers');

      expect(result.edits.some((e) => e.confidence === 'ts_morph')).toBe(true);
      expect(result.edits.some((e) => e.confidence === 'rope')).toBe(true);

      await project.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Non-Python files
  // ═══════════════════════════════════════════════════════════════════════

  describe('9. non-Python files stay filesystem-only', () => {
    it('moves CSS with no import edits', async () => {
      const project = await createTempProject({
        'src/styles/main.css': '.app { display: flex; }',
      });
      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'src/styles/main.css',
        newFile: 'src/css/main.css',
        dryRun: false,
      });
      expect(result.edits).toEqual([]);
      expect(result.files_moved).toEqual([{ from: 'src/styles/main.css', to: 'src/css/main.css' }]);
      expect(await readFile(project, 'src/css/main.css')).toBe('.app { display: flex; }');
      await project.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. Limitations (document rope semantics)
  // ═══════════════════════════════════════════════════════════════════════

  describe('10. limitations', () => {
    it('does not rewrite string literals that look like module paths', async () => {
      const project = await createTempProject(
        pkgHelpersProject({
          'app.py': [
            'from pkg.helpers import format_val',
            'PATH = "pkg.helpers"',
            'MSG = "import pkg.helpers"',
          ].join('\n') + '\n',
        }),
      );

      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });

      const app = await readFile(project, 'app.py');
      expect(app).toContain('from other.helpers import format_val');
      expect(app).toContain('PATH = "pkg.helpers"');
      expect(app).toContain('MSG = "import pkg.helpers"');
      await project.cleanup();
    });

    it('does not rewrite import-like comments', async () => {
      const project = await createTempProject(
        pkgHelpersProject({
          'app.py': [
            'from pkg.helpers import format_val',
            '# from pkg.helpers import other',
          ].join('\n') + '\n',
        }),
      );

      await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });

      const app = await readFile(project, 'app.py');
      expect(app).toContain('from other.helpers import format_val');
      expect(app).toContain('# from pkg.helpers import other');
      await project.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. Error handling
  // ═══════════════════════════════════════════════════════════════════════

  describe('11. error handling', () => {
    let project: TempProject;

    beforeEach(async () => {
      project = await createTempProject({
        'pkg/__init__.py': '',
        'pkg/helpers.py': 'def f():\n    return 1\n',
        'pkg/formatters.py': 'def g():\n    return 2\n',
        'pkg/canvas/__init__.py': '',
        'pkg/canvas/draw.py': 'def draw():\n    return 1\n',
      });
    });

    afterEach(async () => {
      await project.cleanup();
    });

    it('rejects missing source file (fileRename)', async () => {
      await expect(
        fileRename({
          repoPath: project.root,
          oldFile: 'pkg/missing.py',
          newFile: 'pkg/x.py',
          dryRun: true,
        }),
      ).rejects.toThrow();
    });

    it('rejects target file that already exists (fileRename)', async () => {
      await expect(
        fileRename({
          repoPath: project.root,
          oldFile: 'pkg/helpers.py',
          newFile: 'pkg/formatters.py',
          dryRun: true,
        }),
      ).rejects.toThrow(/already exists/i);
    });

    it('rejects identical oldPath/newPath (ropeMove)', async () => {
      await expect(
        ropeMove({
          repoPath: project.root,
          oldPath: 'pkg/helpers.py',
          newPath: 'pkg/helpers.py',
          dryRun: true,
        }),
      ).rejects.toThrow(/identical/i);
    });

    it('rejects missing source path (ropeMove)', async () => {
      await expect(
        ropeMove({
          repoPath: project.root,
          oldPath: 'pkg/nope.py',
          newPath: 'pkg/x.py',
          dryRun: true,
        }),
      ).rejects.toThrow(/does not exist/i);
    });

    it('rejects target path that already exists (ropeMove)', async () => {
      await expect(
        ropeMove({
          repoPath: project.root,
          oldPath: 'pkg/helpers.py',
          newPath: 'pkg/formatters.py',
          dryRun: true,
        }),
      ).rejects.toThrow(/already exists/i);
    });

    it('rejects directory rename when target directory exists', async () => {
      // create target
      await fs.mkdir(path.join(project.root, 'pkg/view'), { recursive: true });
      await expect(
        directoryRename({
          repoPath: project.root,
          oldDir: 'pkg/canvas',
          newDir: 'pkg/view',
          dryRun: true,
        }),
      ).rejects.toThrow(/already exists/i);
    });

    it('rejects fileRename when source path is a directory', async () => {
      await expect(
        fileRename({
          repoPath: project.root,
          oldFile: 'pkg/canvas',
          newFile: 'pkg/view.py',
          dryRun: true,
        }),
      ).rejects.toThrow(/not a file/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. Edit / response shape
  // ═══════════════════════════════════════════════════════════════════════

  describe('12. edit and response shape', () => {
    it('returns well-formed rope edits and files_moved', async () => {
      const project = await createTempProject(
        pkgHelpersProject({
          'app.py': 'from pkg.helpers import format_val\n',
        }),
      );

      const result = await fileRename({
        repoPath: project.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: true,
      });

      expect(result.files_moved.length).toBeGreaterThan(0);
      for (const m of result.files_moved) {
        expect(m.from).toBeTruthy();
        expect(m.to).toBeTruthy();
        expect(m.from).not.toBe(m.to);
      }

      expect(result.edits.length).toBeGreaterThan(0);
      for (const e of result.edits) {
        expect(e.filePath).toBeTruthy();
        expect(e.line).toBeGreaterThan(0);
        expect(typeof e.old_text).toBe('string');
        expect(typeof e.new_text).toBe('string');
        expect(e.old_text).not.toBe(e.new_text);
        expect(e.confidence).toBe('rope');
      }

      await project.cleanup();
    });

    it('apply returns the same shape as dry-run for a simple move', async () => {
      const dryProject = await createTempProject(
        pkgHelpersProject({ 'app.py': 'from pkg.helpers import format_val\n' }),
      );
      const applyProject = await createTempProject(
        pkgHelpersProject({ 'app.py': 'from pkg.helpers import format_val\n' }),
      );

      const dry = await fileRename({
        repoPath: dryProject.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: true,
      });
      const applied = await fileRename({
        repoPath: applyProject.root,
        oldFile: 'pkg/helpers.py',
        newFile: 'other/helpers.py',
        dryRun: false,
      });

      expect(dry.files_moved).toEqual(applied.files_moved);
      expect(dry.edits.map((e) => ({ ...e }))).toEqual(applied.edits.map((e) => ({ ...e })));
      expect(await fileExists(applyProject, 'other/helpers.py')).toBe(true);
      expect(await fileExists(dryProject, 'pkg/helpers.py')).toBe(true);

      await dryProject.cleanup();
      await applyProject.cleanup();
    });
  });
});
