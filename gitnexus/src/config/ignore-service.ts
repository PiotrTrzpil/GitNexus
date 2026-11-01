import ignore, { type Ignore } from 'ignore';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'fs';
import fs from 'fs/promises';
import nodePath from 'path';
import type { Path } from 'path-scurry';
import { readRepoControlFile } from './repo-control-file.js';
import { logger } from '../core/logger.js';
import { getCoreExcludesFilePath, getGitInfoExcludePath } from '../storage/git.js';

const DEFAULT_IGNORE_LIST = new Set([
  // Version Control
  '.git',
  '.svn',
  '.hg',
  '.bzr',

  // IDEs & Editors
  '.idea',
  '.vscode',
  '.vs',
  '.eclipse',
  '.settings',
  '.DS_Store',
  'Thumbs.db',

  // Dependencies
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor', // PHP/Go
  'third_party', // C/C++ (Google-style vendored dependencies)
  '3rdparty', // C/C++ (alternate spelling, also Qt convention)
  // 'packages' removed - commonly used for monorepo source code (lerna, pnpm, yarn workspaces)
  'venv',
  '.venv',
  '.env',
  // Bare `env/` can be application source or a Python virtual environment.
  // Path-aware rules below prune it at the root and wherever pyvenv.cfg marks
  // a virtual environment, while preserving ordinary nested source folders.
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'site-packages',
  'dist-packages',
  '.tox',
  'eggs',
  '.eggs',
  'lib64',
  'parts',
  'sdist',
  'wheels',

  // Build Outputs
  'dist',
  'build',
  'out',
  'bin',
  'obj',
  'target', // Java/Rust
  '.next',
  // `.next` is Next.js's build CACHE; `_next` is the EMITTED output, and the two
  // are different directories. A Capacitor/Cordova shell copies the emitted
  // bundle to `<platform>/app/src/main/assets/public/_next/static/…`, where none
  // of the path segments hit this list — so a mobile-wrapped Next.js app had its
  // shipped bundle indexed as source, and every Route node it produced pointed at
  // a webpack chunk rather than code anyone wrote (#3007).
  //
  // The name is deliberately unanchored. No `<web-root>/_next` form matches a
  // root-level `_next/static/…`, which is the shape the reported repo has, so
  // anchoring it would miss the case it was added for. The accepted cost is a
  // hand-written directory literally named `_next`; recover one with a bare
  // `!_next/` line in `.gitnexusignore`.
  '_next',
  '.nuxt',
  '.output',
  '.vercel',
  '.netlify',
  '.serverless',
  '_build',
  // `'public/build'` used to sit here. This set is tested one path SEGMENT at a
  // time, and `isHardcodedIgnoredDirectory(name)` takes a bare directory name,
  // so a slash-containing member could never match either — it was inert. Its
  // paths were never unignored though: bare `'build'` above already prunes
  // `public/build/**`, so removing the entry changes no behavior (#3007).
  // `test/unit/ignore-build-output.test.ts` keeps the next slash-bearing entry
  // in this set — or in IGNORED_FILES, ROOT_ARTIFACT_DIRECTORIES or
  // IGNORED_EXTENSIONS — from dying the same way.
  '.parcel-cache',
  '.turbo',
  '.svelte-kit',

  // Test & Coverage
  'coverage',
  '.nyc_output',
  'htmlcov',
  '.coverage',
  '__tests__', // Often just test files
  '__mocks__',
  '.jest',

  // Logs & Temp
  // 'logs', 'cache', 'output' and 'fixtures' removed - bare names that often hold
  // real source (src/**/output, test fixtures worth indexing, cache layers).
  // Dot-prefixed build/cache names (.cache, .output) and `log` remain.
  'log',
  'tmp',
  'temp',
  '.cache',
  '.tmp',
  '.temp',

  // Generated/Compiled
  '.generated',
  'auto-generated',
  // Bare `generated/` can contain tracked source-of-truth code. Build output
  // remains covered by .gitignore/.gitnexusignore and the unambiguous names.
  'monaco-workers', // Monaco editor web-worker bundles generated for browser runtime
  '.terraform',

  // Documentation (optional - might want to keep)
  // 'docs',
  // 'documentation',

  // Misc
  '.husky',
  '.github', // GitHub config, not code
  '.circleci',
  '.gitlab',
  'snapshots', // Jest snapshots
  '__snapshots__',
]);

// Ambiguous names that conventionally denote generated artifacts only at the
// repository root. Nested directories with these names are frequently source
// modules (for example apps/web/src/env or packages/api/generated).
const ROOT_ARTIFACT_DIRECTORIES = new Set(['env', 'generated']);

const isRootArtifactDirectory = (relativePath: string, name: string): boolean =>
  !relativePath.includes('/') && ROOT_ARTIFACT_DIRECTORIES.has(name);

const IGNORED_EXTENSIONS = new Set([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.psd',
  '.ai',
  '.sketch',
  '.fig',
  '.xd',

  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.bz2',
  '.xz',
  '.tgz',

  // Binary/Compiled
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.a',
  '.lib',
  '.o',
  '.obj',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.pyc',
  '.pyo',
  '.pyd',
  '.beam', // Erlang
  '.wasm', // WebAssembly - important!
  '.node', // Native Node addons

  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',

  // Media
  '.mp4',
  '.mp3',
  '.wav',
  '.mov',
  '.avi',
  '.mkv',
  '.flv',
  '.wmv',
  '.ogg',
  '.webm',
  '.flac',
  '.aac',
  '.m4a',

  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',

  // Databases
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mdb',
  '.accdb',

  // Minified/Bundled files
  '.min.js',
  '.min.css',
  '.bundle.js',
  '.chunk.js',

  // Source maps (debug files, not source)
  '.map',

  // Lock files (handled separately, but also here)
  '.lock',

  // Certificates & Keys (security - don't index!)
  '.pem',
  '.key',
  '.crt',
  '.cer',
  '.p12',
  '.pfx',

  // Data files (often large/binary)
  '.csv',
  '.tsv',
  '.parquet',
  '.avro',
  '.feather',
  '.npy',
  '.npz',
  '.pkl',
  '.pickle',
  '.h5',
  '.hdf5',

  // Misc binary
  '.bin',
  '.dat',
  '.data',
  '.raw',
  '.iso',
  '.img',
  '.dmg',
]);

// Files to ignore by exact name
const IGNORED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.yarnrc',
  '.editorconfig',
  '.prettierrc',
  '.prettierignore',
  '.eslintignore',
  '.dockerignore',
  'Thumbs.db',
  '.DS_Store',
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'CHANGELOG.md',
  'CHANGELOG',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env.example',
]);

/** Where an ignore decision came from. */
export type IgnoreSource =
  /** A pattern in a `.gitignore` (root or nested). */
  | 'gitignore'
  /** A pattern in the root `.gitnexusignore`. */
  | 'gitnexusignore'
  /** A pattern in core.excludesFile or $GIT_COMMON_DIR/info/exclude. */
  | 'git-exclude'
  /** A directory name in the built-in default list (or a path-aware variant). */
  | 'default-directory'
  /** An exact file name in the built-in never-index list (lock files, LICENSE, .env, ...). */
  | 'default-file'
  /** A binary/media/archive/minified extension in the built-in never-index list. */
  | 'binary-extension'
  /** A `.bundle.` / `.chunk.` / `.generated.` file name. */
  | 'generated-name'
  /** Built-in path rule that is not a plain directory name (Laravel compiled views). */
  | 'default-path'
  /** The path is not inside the repository. */
  | 'outside-repo';

/** The rule that excluded (or re-included) a path. */
export interface IgnoreReason {
  source: IgnoreSource;
  /** Rule file relative to the repo root (or the git exclude file path) for the user-rule sources. */
  file?: string;
  /** The matching pattern line (user rules) or the matching built-in entry (directory name, file name, extension). */
  pattern: string;
}

export interface IgnoreVerdict {
  ignored: boolean;
  /** Present exactly when `ignored` is true. */
  reason?: IgnoreReason;
  /**
   * Set when an explicit `!pattern` negation let the path through. `overrides`
   * is the built-in rule that would have excluded it otherwise, if any.
   */
  reincluded?: { by: IgnoreReason; overrides?: IgnoreReason };
}

const NOT_IGNORED: IgnoreVerdict = { ignored: false };
const ignoredBy = (reason: IgnoreReason): IgnoreVerdict => ({ ignored: true, reason });

/**
 * File-name rules for files that are never source: binary and media
 * extensions, lock files, minified/bundled/generated output (the
 * IGNORED_EXTENSIONS and IGNORED_FILES lists). Unlike the directory defaults,
 * these cannot be re-included with a `!pattern` in `.gitignore` or
 * `.gitnexusignore`: a repo that tracks `docs/assets/*.png` (`*.png` +
 * `!docs/assets/*.png`) wants git to keep them, not the index to parse them.
 * Both `createIgnoreFilter` and `createWatchIgnorePredicate` apply this
 * before they consult any negation.
 */
const explainNeverIndexedFile = (filePath: string): IgnoreReason | null => {
  const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const fileNameLower = fileName.toLowerCase();

  // Check exact filename matches
  if (IGNORED_FILES.has(fileName)) return { source: 'default-file', pattern: fileName };
  if (IGNORED_FILES.has(fileNameLower)) return { source: 'default-file', pattern: fileNameLower };

  // Check extension
  const lastDotIndex = fileNameLower.lastIndexOf('.');
  if (lastDotIndex !== -1) {
    const ext = fileNameLower.substring(lastDotIndex);
    if (IGNORED_EXTENSIONS.has(ext)) return { source: 'binary-extension', pattern: ext };

    // Handle compound extensions like .min.js, .bundle.js
    const secondLastDot = fileNameLower.lastIndexOf('.', lastDotIndex - 1);
    if (secondLastDot !== -1) {
      const compoundExt = fileNameLower.substring(secondLastDot);
      if (IGNORED_EXTENSIONS.has(compoundExt)) {
        return { source: 'binary-extension', pattern: compoundExt };
      }
    }
  }

  // Ignore files that look like generated/bundled code
  for (const marker of ['.bundle.', '.chunk.', '.generated.']) {
    if (fileNameLower.includes(marker)) return { source: 'generated-name', pattern: marker };
  }
  return null;
};

const isNeverIndexedFile = (filePath: string): boolean =>
  explainNeverIndexedFile(filePath) !== null;

// The hardcoded DEFAULT_IGNORE_LIST is the "safety net" default: directories
// that are almost never source code (node_modules, .git, dist, __tests__,
// etc.). Users who legitimately need to index one of these can negate the
// hardcoded rule via a `!pattern` line in `.gitnexusignore` (#771) — same
// semantics as `.gitignore` negation. That override is applied in
// `createIgnoreFilter` below; `shouldIgnorePath` itself stays a pure
// hardcoded-list check so its callers (wiki generator, tests) get
// deterministic results independent of per-repo config.

/** The directory-name and path-shaped built-in rules (everything except the never-index file names). */
const explainDefaultPath = (filePath: string): IgnoreReason | null => {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPathLower = normalizedPath.toLowerCase();
  const parts = normalizedPath.split('/');

  if (parts.length > 0 && isRootArtifactDirectory(parts[0], parts[0])) {
    return { source: 'default-directory', pattern: parts[0] };
  }

  // Laravel compiles Blade templates into generated PHP cache files under
  // storage/framework/views.  Source templates live in resources/views and are
  // handled separately; compiled cache should not become source-of-truth. Keep
  // storage/framework/cache parseable unless a separate warning source is proven:
  // Laravel route/config cache files are ordinary generated PHP, not Blade.
  if (/(^|\/)storage\/framework\/views(\/|$)/.test(normalizedPathLower)) {
    return { source: 'default-path', pattern: 'storage/framework/views' };
  }

  // Check if any path segment is in the hardcoded ignore list.
  for (const part of parts) {
    if (DEFAULT_IGNORE_LIST.has(part)) {
      return { source: 'default-directory', pattern: part };
    }
  }
  return null;
};

export const shouldIgnorePath = (filePath: string): boolean =>
  explainDefaultPath(filePath) !== null || isNeverIndexedFile(filePath);

/** Check if a directory name is in the hardcoded ignore list */
export const isHardcodedIgnoredDirectory = (name: string): boolean => {
  return DEFAULT_IGNORE_LIST.has(name);
};

const explainHardcodedIgnoredDirectoryAtPath = (
  repoRoot: string,
  directoryPath: string,
): IgnoreReason | null => {
  const name = nodePath.basename(directoryPath);
  if (isHardcodedIgnoredDirectory(name)) return { source: 'default-directory', pattern: name };

  const relative = nodePath.relative(repoRoot, directoryPath).replace(/\\/g, '/');
  if (isRootArtifactDirectory(relative, name)) {
    return { source: 'default-directory', pattern: name };
  }

  return name === 'env' && existsSync(nodePath.join(directoryPath, 'pyvenv.cfg'))
    ? { source: 'default-directory', pattern: 'env (contains pyvenv.cfg)' }
    : null;
};

/** Apply directory ignore rules that depend on repository-relative depth. */
export const isHardcodedIgnoredDirectoryAtPath = (
  repoRoot: string,
  directoryPath: string,
): boolean => explainHardcodedIgnoredDirectoryAtPath(repoRoot, directoryPath) !== null;

/**
 * Load .gitignore and .gitnexusignore rules from the repo root.
 * Returns an `ignore` instance with all patterns, or null if no files found.
 */
export interface IgnoreOptions {
  /** Skip .gitignore parsing, only read .gitnexusignore. Defaults to GITNEXUS_NO_GITIGNORE env var. */
  noGitignore?: boolean;
  /** Skip core.excludesFile and $GIT_COMMON_DIR/info/exclude. Defaults to GITNEXUS_NO_GLOBAL_IGNORE env var. */
  noGlobalIgnore?: boolean;
  /** Fail repository-control reloads closed so long-lived watchers keep their prior predicate. */
  strictRepoControlFiles?: boolean;
}

/**
 * A parsed rule file set. Every pattern is added with a `mark` naming the file
 * it came from (`<source>:<file>`), so a match can be traced back to its file
 * and `lines` keeps each pattern line in precedence order for locating the
 * `!negation` that decided a path (the `ignore` package reports only the rule
 * that ignores).
 */
interface RuleSet {
  ig: Ignore;
  lines: { pattern: string; mark: string }[];
  /** True once any rule file was read, even an empty one. */
  found: boolean;
}

type IgnoreRuleInfo = ignore.IgnoreRule;

const newRuleSet = (): RuleSet => ({ ig: ignore(), lines: [], found: false });

const addRuleContent = (set: RuleSet, content: string, source: IgnoreSource, file: string) => {
  const mark = `${source}:${file}`;
  set.found = true;
  for (const pattern of content.split(/\r?\n/)) {
    if (!pattern) continue;
    set.ig.add({ pattern, mark });
    set.lines.push({ pattern, mark });
  }
};

const reasonFromMark = (mark: string | undefined, pattern: string): IgnoreReason => {
  const at = mark?.indexOf(':') ?? -1;
  if (!mark || at === -1) return { source: 'gitignore', pattern };
  return { source: mark.slice(0, at) as IgnoreSource, file: mark.slice(at + 1), pattern };
};

const reasonFromRule = (rule: IgnoreRuleInfo | undefined): IgnoreReason =>
  reasonFromMark(rule?.mark, rule?.pattern ?? '');

const loadRuleSet = async (
  repoPath: string,
  options?: IgnoreOptions,
): Promise<RuleSet | null> => {
  const set = newRuleSet();

  // Mirror git's own precedence for ignore sources (gitignore(5)): patterns
  // from core.excludesFile are consulted first (lowest precedence — git's
  // real global, all-repos file), then $GIT_COMMON_DIR/info/exclude
  // (per-repo, untracked — no write access to the repo needed), then
  // .gitignore/.gitnexusignore below. Later ig.add() calls win on
  // conflicting patterns, matching git's own last-match-wins semantics (#2606).
  const skipGlobalIgnore = options?.noGlobalIgnore ?? !!process.env.GITNEXUS_NO_GLOBAL_IGNORE;
  if (!skipGlobalIgnore) {
    const globalSources = [
      getCoreExcludesFilePath(repoPath),
      getGitInfoExcludePath(repoPath),
    ].filter((candidate): candidate is string => candidate !== null);
    for (const sourcePath of globalSources) {
      try {
        const content = await fs.readFile(sourcePath, 'utf-8');
        addRuleContent(set, content, 'git-exclude', sourcePath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          logger.warn(`  Warning: could not read ${sourcePath}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Allow users to bypass .gitignore parsing (e.g. when .gitignore accidentally excludes source files)
  const skipGitignore = options?.noGitignore ?? !!process.env.GITNEXUS_NO_GITIGNORE;
  const filenames = skipGitignore ? ['.gitnexusignore'] : ['.gitignore', '.gitnexusignore'];

  for (const filename of filenames) {
    try {
      const content = options?.strictRepoControlFiles
        ? await readRepoControlFile(repoPath, filename)
        : await fs.readFile(nodePath.join(repoPath, filename), 'utf-8');
      if (content === null) continue;
      addRuleContent(
        set,
        content,
        filename === '.gitnexusignore' ? 'gitnexusignore' : 'gitignore',
        filename,
      );
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!options?.strictRepoControlFiles && code === 'ENOENT') continue;
      if (options?.strictRepoControlFiles) throw err;
      logger.warn(`  Warning: could not read ${filename}: ${(err as Error).message}`);
    }
  }

  return set.found ? set : null;
};

export const loadIgnoreRules = async (
  repoPath: string,
  options?: IgnoreOptions,
): Promise<Ignore | null> => (await loadRuleSet(repoPath, options))?.ig ?? null;

/**
 * Build a synchronous predicate for long-lived filesystem watchers.
 *
 * Unlike {@link createIgnoreFilter}, callers pass ordinary absolute or
 * repository-relative paths instead of path-scurry `Path` objects. The rule
 * precedence deliberately mirrors the scanner: explicit negations win over
 * hardcoded defaults unless a more-specific rule re-ignores the path.
 * Binary/never-index file types are checked before any negation.
 */
export const createWatchIgnorePredicate = async (
  repoPath: string,
  options?: IgnoreOptions,
): Promise<(candidatePath: string, isDirectory?: boolean) => boolean> => {
  const ig = await loadRuleSet(repoPath, { ...options, strictRepoControlFiles: true });
  const repoRoot = nodePath.resolve(repoPath);

  return (candidatePath: string, isDirectory = false): boolean => {
    const absolute = nodePath.isAbsolute(candidatePath)
      ? nodePath.resolve(candidatePath)
      : nodePath.resolve(repoRoot, candidatePath);
    const rel = nodePath.relative(repoRoot, absolute).replace(/\\/g, '/');
    if (!rel) return false;
    if (rel === '..' || rel.startsWith('../') || nodePath.isAbsolute(rel)) return true;
    return evaluateWatchPath(ig, repoRoot, absolute, rel, isDirectory).ignored;
  };
};

/**
 * The watcher's decision for one in-repo path. Same chain as the scanner's
 * non-nested fallback, plus the hardcoded directory rules for directories.
 */
const evaluateWatchPath = (
  rules: RuleSet | null,
  repoRoot: string,
  absolute: string,
  rel: string,
  isDirectory: boolean,
): IgnoreVerdict => {
  // Binary/lock/generated file types are never source; no negation rescues them.
  const neverIndexed = explainNeverIndexedFile(rel);
  if (neverIndexed) return ignoredBy(neverIndexed);

  const probe = isDirectory ? `${rel}/` : rel;
  const reincluded = rules ? reincludedByNegation(rules, rel, probe) : null;
  if (reincluded) return reincluded;
  const hit = rules ? ruleHit(rules, probe) : null;
  if (hit) return hit;
  if (isDirectory) {
    const dir = explainHardcodedIgnoredDirectoryAtPath(repoRoot, absolute);
    if (dir) return ignoredBy(dir);
  }
  const fallback = explainDefaultPath(rel);
  return fallback ? ignoredBy(fallback) : NOT_IGNORED;
};

/**
 * Walk ancestor segments of `rel` and look for an explicit `!pattern`
 * negation in `.gitnexusignore` (or `.gitignore`) that applies. Returns the
 * first candidate path — the path itself, itself as a directory, or an
 * ancestor directory — that a negation rule matches, or null.
 *
 * Why this exists (#771): the hardcoded DEFAULT_IGNORE_LIST would
 * otherwise block indexing of directories like `__tests__/` even when
 * the user has an explicit `!__tests__/` line in `.gitnexusignore`.
 * Mirroring `.gitignore` negation semantics: a user's explicit
 * unignore of a parent directory implicitly unignores everything
 * underneath, so we walk the ancestor chain rather than only testing
 * the leaf.
 *
 * The `ignore` package's `test(path)` returns `{ignored, unignored}`;
 * `unignored: true` is the "a negation rule matched this path"
 * signal. Children of a negated directory return
 * `{ignored: false, unignored: false}` on a direct test, which is why
 * we also walk the ancestors here.
 */
const findExplicitUnignore = (ig: Ignore, rel: string): string | null => {
  // Direct match on the path (as a file).
  if (ig.test(rel).unignored) return rel;
  // Direct match on the path treated as a directory — `!dir/` matches
  // here when rel is the directory itself.
  if (ig.test(rel + '/').unignored) return rel + '/';
  // Walk ancestor segments. `!parent/` should propagate to every
  // descendant the same way `.gitignore` negation propagates.
  const parts = rel.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join('/') + '/';
    if (ig.test(ancestor).unignored) return ancestor;
  }
  return null;
};

/** The last pattern in `rules` matching `candidate`, i.e. the one that decides it (the `ignore` package does not report a negation). */
const decidingRule = (rules: RuleSet, candidate: string): IgnoreReason | null => {
  for (let i = rules.lines.length - 1; i >= 0; i--) {
    const { pattern, mark } = rules.lines[i];
    const single = ignore().add({ pattern }).test(candidate);
    if (single.ignored || single.unignored) return reasonFromMark(mark, pattern);
  }
  return null;
};

/**
 * A negation outranks the built-in directory defaults and any earlier rule,
 * unless a more specific rule re-ignores the exact `probe` path
 * (last-match-wins, as in .gitignore). Returns the "re-included" verdict, or
 * null when no negation applies.
 */
const reincludedByNegation = (
  rules: RuleSet,
  rel: string,
  probe: string,
): IgnoreVerdict | null => {
  const candidate = findExplicitUnignore(rules.ig, rel);
  if (candidate === null || rules.ig.ignores(probe)) return null;
  const by = decidingRule(rules, candidate);
  if (!by) return null;
  const overrides = explainDefaultPath(rel);
  return { ignored: false, reincluded: overrides ? { by, overrides } : { by } };
};

/** The pattern that ignores `probe`, if any. */
const ruleHit = (rules: RuleSet, probe: string): IgnoreVerdict | null => {
  const result = rules.ig.test(probe);
  return result.ignored ? ignoredBy(reasonFromRule(result.rule)) : null;
};

/**
 * Read a nested `.gitignore` only if it is a regular file, not a symlink.
 *
 * git does not follow a symlinked `.gitignore` in the working tree, and
 * reading one could pull rules from outside the repository. Where the
 * platform supports it, the file is opened with O_NOFOLLOW (a symlink fails
 * with ELOOP). Windows has no O_NOFOLLOW, so there the path is lstat'ed after
 * opening and must be the same regular file as the open descriptor. Either
 * way the content is read through the descriptor that was checked, never by
 * path, so the file cannot be swapped between the check and the read.
 *
 * The open also passes O_NONBLOCK where it exists. Opening a FIFO for reading
 * blocks in open(2) until a writer appears, so a `.gitignore` that is a FIFO
 * would hang the scan before the isFile() check could reject it (glob's
 * ignore callback is synchronous). The flag makes that open return at once
 * and changes nothing for a regular file. Same reasoning as readBoundedFile
 * in src/core/ingestion/asyncapi/document.ts.
 */
const readNestedGitignore = (filePath: string): string | null => {
  const noFollow = fsConstants.O_NOFOLLOW;
  const nonBlock = fsConstants.O_NONBLOCK;
  const fd = openSync(filePath, fsConstants.O_RDONLY | (noFollow ?? 0) | (nonBlock ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (noFollow === undefined) {
      const link = lstatSync(filePath);
      if (!link.isFile() || link.ino !== stat.ino || link.dev !== stat.dev) return null;
    }
    return readFileSync(fd, 'utf-8');
  } finally {
    closeSync(fd);
  }
};

/**
 * Resolve `.gitignore` files below the repository root (#2675).
 *
 * `loadIgnoreRules` only reads the root `.gitignore`, so a monorepo package
 * or checked-out submodule with its own `.gitignore` had its generated
 * output indexed anyway. Each nested file is read lazily (glob's filter is
 * synchronous) and cached per directory, and its patterns are matched
 * against the path relative to that directory, like git does.
 *
 * Returns the effective decision (with the rule behind an exclusion) when
 * nested rules affect the path or an ancestor, and `undefined` otherwise. Root rules participate so a directory
 * negation does not erase independent root exclusions for its children.
 * The caller still gives `.gitnexusignore` its higher precedence.
 */
interface NestedVerdict {
  ignored: boolean;
  /** The pattern behind an exclusion; its `mark` names the `.gitignore` it came from. */
  rule?: IgnoreRuleInfo;
}

const createNestedGitignoreMatcher = (
  repoPath: string,
  rootRules: Ignore | null,
): ((rel: string, isDirectory: boolean) => NestedVerdict | undefined) => {
  const rulesFor = (dirRel: string): Ignore | null => {
    let rules: Ignore | null = null;
    const filePath = nodePath.join(repoPath, dirRel, '.gitignore');
    try {
      const content = readNestedGitignore(filePath);
      if (content !== null) {
        const set = newRuleSet();
        addRuleContent(set, content, 'gitignore', nodePath.posix.join(dirRel, '.gitignore'));
        rules = set.ig;
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') {
        logger.warn(`  Warning: could not read ${filePath}: ${(err as Error).message}`);
      }
    }
    return rules;
  };

  interface Scope {
    base: string;
    rules: Ignore;
  }
  interface DirectoryContext {
    scopes: Scope[];
    ignored: boolean;
    nested: boolean;
    /** The rule that excluded this directory (or the ancestor it inherits the exclusion from). */
    cause?: IgnoreRuleInfo;
  }

  const relativeTo = (base: string, rel: string): string =>
    base ? rel.slice(base.length + 1) : rel;
  const match = (scopes: Scope[], rel: string, isDirectory: boolean) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const { base, rules } = scopes[i];
      const sub = relativeTo(base, rel);
      const result = rules.test(isDirectory ? `${sub}/` : sub);
      if (result.ignored || result.unignored) {
        return { ignored: result.ignored, nested: base !== '', rule: result.rule };
      }
    }
    return undefined;
  };

  const contexts = new Map<string, DirectoryContext>([
    [
      '',
      {
        scopes: rootRules ? [{ base: '', rules: rootRules }] : [],
        ignored: false,
        nested: false,
      },
    ],
  ]);

  const contextFor = (dir: string): DirectoryContext => {
    const cached = contexts.get(dir);
    if (cached) return cached;
    const parentDir = nodePath.posix.dirname(dir);
    const parent = contextFor(parentDir === '.' ? '' : parentDir);
    // A .gitignore inside an excluded directory cannot bring that directory
    // back. Do not read rules below a parent that traversal would prune.
    if (parent.ignored) {
      contexts.set(dir, parent);
      return parent;
    }

    const result = match(parent.scopes, dir, true);
    const context: DirectoryContext = {
      scopes: parent.scopes,
      ignored: result?.ignored ?? false,
      nested: parent.nested || (result?.nested ?? false),
      cause: result?.rule,
    };
    if (!context.ignored) {
      context.scopes = parent.scopes.map(({ base, rules }) => {
        const sub = relativeTo(base, dir);
        if (!rules.test(`${sub}/`).ignored) return { base, rules };
        // A deeper rule let us enter this directory. Clear only its inherited
        // exclusion in the shallower layer; child rules must still be tested.
        // Keep patterns in their original scope, and escape this literal path.
        const literal = sub.replace(/[\\*?\[\]]/g, '\\$&');
        return {
          base,
          rules: ignore()
            .add(rules)
            .add({ pattern: `!/${literal}/` }),
        };
      });
      const rules = rulesFor(dir);
      if (rules) context.scopes.push({ base: dir, rules });
    }
    contexts.set(dir, context);
    return context;
  };

  return (rel: string, isDirectory: boolean): NestedVerdict | undefined => {
    const parentDir = nodePath.posix.dirname(rel);
    const parent = contextFor(parentDir === '.' ? '' : parentDir);
    if (parent.ignored) return parent.nested ? { ignored: true, rule: parent.cause } : undefined;
    const result = match(parent.scopes, rel, isDirectory);
    if (parent.nested || result?.nested) {
      return { ignored: result?.ignored ?? false, rule: result?.rule };
    }
    return undefined;
  };
};

/**
 * The scanner's decision procedure, shared by the glob filter
 * ({@link createIgnoreFilter}) and the explanation ({@link explainIgnore}):
 * every decision carries the rule behind it, so what `why-ignored` reports is
 * by construction what the walker did.
 *
 * Precedence (#771): binary/never-index file types first; then the user's
 * `.gitnexusignore` negation patterns, which take priority over the hardcoded
 * directory defaults, matching `.gitignore` semantics. An explicit `!pattern`
 * rule unignores descendants even when they would otherwise be blocked by
 * DEFAULT_IGNORE_LIST — UNLESS a more specific rule in the same file
 * re-ignores a subset (e.g. `!__tests__/` paired with `__tests__/generated/`
 * blocks the child while leaving the parent negated). Last-match-wins is
 * enforced by consulting `ig.ignores(rel)` after `findExplicitUnignore`.
 */
const createIgnoreEvaluator = async (repoPath: string, options?: IgnoreOptions) => {
  const rules = await loadRuleSet(repoPath, options);
  const ig = rules?.ig ?? null;
  const skipGitignore = options?.noGitignore ?? !!process.env.GITNEXUS_NO_GITIGNORE;
  const nestedIgnores = skipGitignore ? null : createNestedGitignoreMatcher(repoPath, ig);
  // A nested negation outranks the root .gitignore, as in git, but not the
  // user's .gitnexusignore, so keep a matcher for that file on its own.
  const nexusRules = nestedIgnores
    ? await loadRuleSet(repoPath, { ...options, noGitignore: true, noGlobalIgnore: true })
    : null;

  /** What the walker asks of every file (and directory entry) it sees. */
  const evaluateFile = (rel: string): IgnoreVerdict => {
    if (!rel) return NOT_IGNORED;
    // Binary/lock/generated file types are never source; no negation
    // (root, nested or .gitnexusignore) rescues them.
    const neverIndexed = explainNeverIndexedFile(rel);
    if (neverIndexed) return ignoredBy(neverIndexed);

    // Nested .gitignore files below the root (#2675). .gitnexusignore
    // comes first, then the deepest nested .gitignore, which outranks the
    // root .gitignore as in git. The nested matcher preserves independent
    // root exclusions; a nested negation never rescues a hardcoded default.
    // With no nested opinion the original order below applies unchanged.
    if (nestedIgnores) {
      if (nexusRules) {
        if (findExplicitUnignore(nexusRules.ig, rel) !== null && !ig?.ignores(rel)) {
          return reincludedByNegation(nexusRules, rel, rel) ?? NOT_IGNORED;
        }
        const hit = ruleHit(nexusRules, rel);
        if (hit) return hit;
      }
      const nested = nestedIgnores(rel, false);
      if (nested?.ignored) return ignoredBy(reasonFromRule(nested.rule));
      if (nested) {
        const reincluded = rules ? reincludedByNegation(rules, rel, rel) : null;
        if (reincluded) return reincluded;
        const fallback = explainDefaultPath(rel);
        return fallback ? ignoredBy(fallback) : NOT_IGNORED;
      }
    }
    // User's .gitnexusignore negation takes precedence over hardcoded
    // rules (#771). If any ancestor or the path itself was explicitly
    // unignored AND no more-specific rule re-ignores this exact path,
    // allow it through. The `!ig.ignores(rel)` guard matches
    // .gitignore's last-match-wins semantics: `!__tests__/` followed
    // by `__tests__/generated/` negates the parent but still blocks
    // the re-ignored child.
    const reincluded = rules ? reincludedByNegation(rules, rel, rel) : null;
    if (reincluded) return reincluded;
    // Check .gitignore / .gitnexusignore patterns
    const hit = rules ? ruleHit(rules, rel) : null;
    if (hit) return hit;
    // Fall back to hardcoded rules
    const fallback = explainDefaultPath(rel);
    return fallback ? ignoredBy(fallback) : NOT_IGNORED;
  };

  /** What the walker asks of every directory before descending into it. */
  const evaluateDirectory = (rel: string): IgnoreVerdict => {
    if (!rel) return NOT_IGNORED;
    const dir = `${rel}/`;
    const hardcoded = () => {
      const reason = explainHardcodedIgnoredDirectoryAtPath(repoPath, nodePath.join(repoPath, rel));
      return reason ? ignoredBy(reason) : NOT_IGNORED;
    };
    // Note: dot-directories (.git, .vscode, etc.) are primarily excluded by
    // glob's `dot: false` option in filesystem-walker.ts. The hardcoded
    // list check below is defense-in-depth — do not remove `dot: false`
    // assuming this covers it.
    //
    // Nested .gitignore files below the root (#2675), same precedence as in
    // `evaluateFile` above.
    if (nestedIgnores) {
      if (nexusRules) {
        if (findExplicitUnignore(nexusRules.ig, rel) !== null && !ig?.ignores(dir)) {
          return reincludedByNegation(nexusRules, rel, dir) ?? NOT_IGNORED;
        }
        const hit = ruleHit(nexusRules, dir);
        if (hit) return hit;
      }
      const nested = nestedIgnores(rel, true);
      if (nested?.ignored) return ignoredBy(reasonFromRule(nested.rule));
      if (nested) {
        const reincluded = rules ? reincludedByNegation(rules, rel, dir) : null;
        return reincluded ?? hardcoded();
      }
    }
    // User's .gitnexusignore negation takes precedence (#771) — if the
    // user explicitly unignored this directory or any ancestor via a
    // !pattern rule, allow descent even if the directory name is in
    // DEFAULT_IGNORE_LIST. The `!ig.ignores(rel + '/')` guard keeps
    // last-match-wins: `!__tests__/` + `__tests__/generated/` still
    // blocks descent into `__tests__/generated/`.
    const reincluded = rules ? reincludedByNegation(rules, rel, dir) : null;
    if (reincluded) return reincluded;
    // Hardcoded and path-aware rules prune whole trees before glob walks them.
    const pruned = hardcoded();
    if (pruned.ignored) return pruned;
    // Check against .gitignore / .gitnexusignore patterns.
    // Since this is only asked of directories, always test with a trailing
    // slash. This ensures directory-only negation patterns (e.g. `!iOS/`) are
    // applied correctly — without the slash, `ig.ignores('iOS')` treats the
    // path as a file and misses the negation. Bare-name patterns (e.g.
    // `local`) still match `local/` per gitignore spec: the `ignore` package
    // normalizes `dir` and `dir/` to match directories.
    // See: https://github.com/kaelzhang/node-ignore#2-filenames-and-dirnames
    return (rules ? ruleHit(rules, dir) : null) ?? NOT_IGNORED;
  };

  return { evaluateFile, evaluateDirectory };
};

/**
 * Create a glob-compatible ignore filter combining:
 * - .gitignore / .gitnexusignore patterns (via `ignore` package)
 * - nested .gitignore files, scoped to their own directory (#2675)
 * - Hardcoded DEFAULT_IGNORE_LIST, IGNORED_EXTENSIONS, IGNORED_FILES
 *
 * Returns an IgnoreLike object for glob's `ignore` option,
 * enabling directory-level pruning during traversal. Precedence is described
 * on {@link createIgnoreEvaluator}.
 */
export const createIgnoreFilter = async (repoPath: string, options?: IgnoreOptions) => {
  const { evaluateFile, evaluateDirectory } = await createIgnoreEvaluator(repoPath, options);
  return {
    // The `ignore` package expects POSIX separators; path-scurry can surface
    // native separators on Windows when called through glob.
    ignored: (p: Path): boolean => evaluateFile(p.relative().replace(/\\/g, '/')).ignored,
    childrenIgnored: (p: Path): boolean =>
      evaluateDirectory(p.relative().replace(/\\/g, '/')).ignored,
  };
};

export interface IgnoreExplanation {
  /** Repo-relative POSIX path that was examined. */
  path: string;
  ignored: boolean;
  /** The rule that excludes the path. */
  reason?: IgnoreReason;
  /** When the exclusion comes from an ancestor directory that the walker prunes, that directory. */
  prunedAt?: string;
  /** A `!pattern` negation that let the path through (or through its ancestor), with the built-in rule it overrode, if any. */
  reincluded?: { by: IgnoreReason; overrides?: IgnoreReason; at: string };
}

/**
 * Explain the scanner's decision for one repo-relative path by replaying the
 * walker's own checks: each ancestor directory is asked first (a pruned
 * directory hides everything below it), then the path itself.
 */
export const explainIgnore = async (
  repoPath: string,
  relPath: string,
  options?: IgnoreOptions & { isDirectory?: boolean },
): Promise<IgnoreExplanation> => {
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const { evaluateFile, evaluateDirectory } = await createIgnoreEvaluator(repoPath, options);
  const parts = rel.split('/');
  let reincluded: IgnoreExplanation['reincluded'];
  const note = (verdict: IgnoreVerdict, at: string) => {
    if (verdict.reincluded) reincluded ??= { ...verdict.reincluded, at };
  };

  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    const verdict = evaluateDirectory(dir);
    if (verdict.ignored) return { path: rel, ignored: true, reason: verdict.reason, prunedAt: dir };
    note(verdict, dir);
  }
  const verdict = options?.isDirectory ? evaluateDirectory(rel) : evaluateFile(rel);
  note(verdict, rel);
  return verdict.ignored
    ? { path: rel, ignored: true, reason: verdict.reason, ...(reincluded && { reincluded }) }
    : { path: rel, ignored: false, ...(reincluded && { reincluded }) };
};
