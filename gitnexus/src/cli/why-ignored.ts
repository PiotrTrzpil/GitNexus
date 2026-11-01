/**
 * `gitnexus why-ignored <path...>` — explain why a path is (not) indexed.
 *
 * The ignore decision itself lives in `config/ignore-service.ts`; this command
 * asks `explainIgnore` (the same procedure the analyze walker runs) and adds
 * the two walker-level exclusions that sit outside the ignore rules: hidden
 * paths (glob's `dot: false`) and the large-file cap.
 *
 * Output is JSON on stdout, one entry per path.
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { explainIgnore, type IgnoreReason, type IgnoreSource } from '../config/ignore-service.js';
import { getIncludeDotDirs } from '../core/ingestion/utils/include-dot-dirs.js';
import { getMaxFileSizeBytes } from '../core/ingestion/utils/max-file-size.js';
import { getGitRoot } from '../storage/git.js';
import { cliErrorKey } from './cli-message.js';

type WhySource = IgnoreSource | 'hidden' | 'size-limit';

export interface WhyIgnoredRule {
  source: WhySource;
  /** The rule file (relative to the repo root) for `.gitignore` / `.gitnexusignore` / git exclude rules. */
  file?: string;
  /** The matching pattern line, built-in entry, or size threshold. */
  pattern: string;
}

export interface WhyIgnoredResult {
  /** Repo-relative POSIX path. */
  path: string;
  indexed: boolean;
  /** The rule that excludes the path; absent when indexed. */
  excludedBy?: WhyIgnoredRule;
  /** Set when the exclusion comes from a pruned ancestor directory. */
  prunedAt?: string;
  /** Set when a `!pattern` negation re-included the path (or an ancestor), and the built-in rule it overrode. */
  reincludedBy?: { rule: WhyIgnoredRule; at: string; overrides?: WhyIgnoredRule };
}

export interface WhyIgnoredOutput {
  repo: string;
  results: WhyIgnoredResult[];
}

const toRule = (reason: IgnoreReason): WhyIgnoredRule => ({ ...reason });

const hiddenSegment = (rel: string, includeDotDirs: readonly string[]): string | undefined => {
  const parts = rel.split('/');
  // A listed dot directory (GITNEXUS_INCLUDE_DOT_DIRS) is walked; any other dot segment is not.
  return parts.find((part) => part.startsWith('.') && !includeDotDirs.includes(part));
};

const explainOne = async (
  repoRoot: string,
  target: string,
  includeDotDirs: readonly string[],
): Promise<WhyIgnoredResult | null> => {
  const absolute = nodePath.resolve(target);
  const rel = nodePath.relative(repoRoot, absolute).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || nodePath.isAbsolute(rel)) return null;

  const stat = await fs.stat(absolute).catch(() => null);
  const hidden = hiddenSegment(rel, includeDotDirs);
  if (hidden) {
    return { path: rel, indexed: false, excludedBy: { source: 'hidden', pattern: hidden } };
  }

  const explanation = await explainIgnore(repoRoot, rel, { isDirectory: stat?.isDirectory() });
  const result: WhyIgnoredResult = { path: rel, indexed: !explanation.ignored };
  if (explanation.reincluded) {
    result.reincludedBy = {
      rule: toRule(explanation.reincluded.by),
      at: explanation.reincluded.at,
      ...(explanation.reincluded.overrides && {
        overrides: toRule(explanation.reincluded.overrides),
      }),
    };
  }
  if (explanation.ignored && explanation.reason) {
    result.excludedBy = toRule(explanation.reason);
    if (explanation.prunedAt) result.prunedAt = explanation.prunedAt;
    return result;
  }

  const maxBytes = getMaxFileSizeBytes();
  if (stat?.isFile() && stat.size > maxBytes) {
    result.indexed = false;
    result.excludedBy = {
      source: 'size-limit',
      pattern: `${stat.size} bytes > ${maxBytes} bytes (GITNEXUS_MAX_FILE_SIZE)`,
    };
  }
  return result;
};

export async function whyIgnoredCommand(
  paths: string[],
  options?: { repo?: string },
): Promise<void> {
  const root = options?.repo ? nodePath.resolve(options.repo) : process.cwd();
  const repoRoot = options?.repo ? (getGitRoot(root) ?? root) : getGitRoot(root);
  if (!repoRoot) {
    cliErrorKey('whyIgnored.notGitRepo');
    process.exitCode = 1;
    return;
  }

  const includeDotDirs = getIncludeDotDirs();
  const results: WhyIgnoredResult[] = [];
  for (const target of paths) {
    const result = await explainOne(repoRoot, target, includeDotDirs);
    if (!result) {
      cliErrorKey('whyIgnored.outsideRepo', { path: target, repo: repoRoot });
      process.exitCode = 1;
      return;
    }
    results.push(result);
  }

  const output: WhyIgnoredOutput = { repo: repoRoot, results };
  process.stdout.write(JSON.stringify(output, null, process.stdout.isTTY ? 2 : undefined) + '\n');
}
