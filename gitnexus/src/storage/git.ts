import { execSync } from 'child_process';
import path from 'path';

// Git utilities for repository detection, commit tracking, and diff analysis

export const isGitRepo = (repoPath: string): boolean => {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoPath, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const getCurrentCommit = (repoPath: string): string => {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();
  } catch {
    return '';
  }
};

/**
 * Find the git repository root from any path inside the repo
 */
export const getGitRoot = (fromPath: string): string | null => {
  try {
    const raw = execSync('git rev-parse --show-toplevel', { cwd: fromPath })
      .toString()
      .trim();
    // On Windows, git returns /d/Projects/Foo — path.resolve normalizes to D:\Projects\Foo
    return path.resolve(raw);
  } catch {
    return null;
  }
};

/**
 * Retrieve the contents of a file at a specific git ref (e.g. HEAD, a commit hash)
 * Returns null if the ref or file does not exist.
 */
export const gitShow = (repoPath: string, ref: string, filePath: string): string | null => {
  try {
    // Normalize filePath to be relative to repo root (git show requires relative paths)
    const relPath = path.isAbsolute(filePath)
      ? path.relative(path.resolve(repoPath), filePath)
      : filePath;
    return execSync(`git show ${ref}:${relPath}`, {
      cwd: repoPath,
      maxBuffer: 50 * 1024 * 1024, // 50MB
    }).toString();
  } catch {
    return null;
  }
};

/**
 * Run `git log --name-only` since a given date and return the raw output.
 * Used for git change coupling analysis.
 * Format: `--pretty=format:COMMIT:%H` so commits and filenames can be parsed.
 */
export const gitLogNameOnly = (repoPath: string, since: string): string => {
  try {
    return execSync(
      `git log --name-only --pretty=format:COMMIT:%H --since="${since}"`,
      { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 }
    ).toString();
  } catch {
    return '';
  }
};
