/**
 * Read side of the `CO_CHANGES_WITH` edges written by the `coChange` phase.
 * `confidence` holds the strength, `step` the co-change count. Edges are stored
 * once per pair, so both directions are matched.
 */
import { executeParameterized } from '../../core/lbug/pool-adapter.js';

export interface CoChangedFile {
  file: string;
  /** Co-changes / the less-active file's changes, 0..1 (two decimals). */
  strength: number;
  /** Commits that touched both files. */
  count: number;
}

/** Partners listed per file in `impact`. */
export const IMPACT_CO_CHANGED_LIMIT = 5;
/** Partners listed in total for `detect_changes`. */
export const DETECT_CHANGES_CO_CHANGED_LIMIT = 5;

interface Row {
  file: string;
  partner: string;
  strength: number;
  count: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Co-change partners of `files`, grouped by file, strongest first. Returns an
 * empty map when the index has no such edges or the query fails: the signal is
 * advisory and must never fail the tool that carries it.
 */
export async function queryCoChanged(
  lbugPath: string,
  files: readonly string[],
): Promise<Map<string, CoChangedFile[]>> {
  const out = new Map<string, CoChangedFile[]>();
  if (files.length === 0) return out;
  let rows: Row[];
  try {
    rows = (await executeParameterized(
      lbugPath,
      `MATCH (a:File)-[r:CodeRelation]-(b:File)
       WHERE r.type = 'CO_CHANGES_WITH' AND a.filePath IN $files
       RETURN a.filePath AS file, b.filePath AS partner, r.confidence AS strength, r.step AS count`,
      { files: [...files] },
    )) as Row[];
  } catch {
    return out;
  }
  for (const row of rows) {
    const list = out.get(row.file) ?? [];
    list.push({ file: row.partner, strength: round2(row.strength), count: row.count });
    out.set(row.file, list);
  }
  for (const list of out.values()) {
    // Most shared commits first: strength alone ranks a file that changed three
    // times (always with this one) above a page that changed with it five times.
    list.sort((x, y) => y.count - x.count || y.strength - x.strength || x.file.localeCompare(y.file));
  }
  return out;
}

export interface UnchangedPartner extends CoChangedFile {
  /** Changed files this partner usually changes with. */
  with: string[];
}

/**
 * For a diff: files that usually change with the changed ones but are not in
 * the diff, most shared commits first, capped to `limit`.
 */
export function partnersMissingFromDiff(
  byFile: ReadonlyMap<string, readonly CoChangedFile[]>,
  changedFiles: ReadonlySet<string>,
  limit: number = DETECT_CHANGES_CO_CHANGED_LIMIT,
): UnchangedPartner[] {
  const merged = new Map<string, UnchangedPartner>();
  for (const [changed, partners] of byFile) {
    for (const p of partners) {
      if (changedFiles.has(p.file)) continue;
      const existing = merged.get(p.file);
      if (!existing) {
        merged.set(p.file, { ...p, with: [changed] });
      } else {
        existing.with.push(changed);
        if (p.count > existing.count || (p.count === existing.count && p.strength > existing.strength)) {
          existing.strength = p.strength;
          existing.count = p.count;
        }
      }
    }
  }
  return [...merged.values()]
    .sort(
      (x, y) =>
        y.count - x.count || y.strength - x.strength || x.file.localeCompare(y.file),
    )
    .slice(0, limit)
    .map((p) => ({ ...p, with: p.with.sort() }));
}
