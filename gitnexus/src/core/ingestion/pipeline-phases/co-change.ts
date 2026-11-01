/**
 * Phase: coChange
 *
 * Mines git history for files that usually change together and adds
 * `CO_CHANGES_WITH` File↔File edges (see `../co-change.ts` for the scoring).
 *
 * Edge encoding, using existing relationship columns so the table schema is
 * unchanged: `confidence` = strength (0..1), `step` = co-change count.
 * Direction is canonical (smaller path → larger path); readers match both ways.
 *
 * On by default: it costs one bounded `git log` (a few hundred ms on a repo
 * with 2,000 commits). Skip with `GITNEXUS_NO_CO_CHANGE=1` or
 * `PipelineOptions.skipCoChange`. Non-git repos, repos without history and
 * timeouts skip silently.
 *
 * Whole-repo derived data: the pair set depends on history, not on any one
 * file's content, so incremental runs delete every `CO_CHANGES_WITH` edge and
 * re-include all of them from the fresh graph (see `isGraphWideRelationship`
 * in `incremental/subgraph-extract.ts`).
 *
 * @deps    structure
 * @reads   File nodes' paths (scan), git history
 * @writes  graph (CO_CHANGES_WITH edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import { generateId } from '../../../lib/utils.js';
import { computeCoChangePairs, readGitCommits } from '../co-change.js';
import { isDev } from '../utils/env.js';
import { logger } from '../../logger.js';

export interface CoChangeOutput {
  edgesAdded: number;
}

/** Env opt-out, read at phase-list build time and again in the phase. */
export const isCoChangeDisabledByEnv = (): boolean => {
  const v = process.env.GITNEXUS_NO_CO_CHANGE;
  return v === '1' || v === 'true';
};

export const coChangePhase: PipelinePhase<CoChangeOutput> = {
  name: 'coChange',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<CoChangeOutput> {
    const { allPathSet } = getPhaseOutput<StructureOutput>(deps, 'structure');

    const commits = await readGitCommits(ctx.repoPath);
    if (commits === null || commits.length === 0) return { edgesAdded: 0 };

    const pairs = computeCoChangePairs(commits, (file) => allPathSet.has(file));
    for (const pair of pairs) {
      ctx.graph.addRelationship({
        id: generateId('CO_CHANGES_WITH', `${pair.fileA}->${pair.fileB}`),
        type: 'CO_CHANGES_WITH',
        sourceId: generateId('File', pair.fileA),
        targetId: generateId('File', pair.fileB),
        confidence: Math.round(pair.strength * 1000) / 1000,
        reason: 'git-co-change',
        step: pair.count,
      });
    }

    if (isDev) {
      logger.info(
        `Co-change: ${pairs.length} file pairs from ${commits.length} commits (CO_CHANGES_WITH)`,
      );
    }
    return { edgesAdded: pairs.length };
  },
};
