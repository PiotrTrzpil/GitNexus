/**
 * HTTP similarity functions ported verbatim from
 * codebase-memory-mcp/internal/httplink/similarity.go
 */

/**
 * levenshteinDistance computes the edit distance between two strings.
 * Uses a two-row rolling array for O(min(m,n)) space.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === '') return b.length;
  if (b === '') return a.length;

  // Use two rows instead of full matrix for space efficiency
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, Math.min(prev[j] + 1, prev[j - 1] + cost));
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

/**
 * normalizedLevenshtein returns 1.0 - (distance / maxLen), so 1.0 = identical.
 */
export function normalizedLevenshtein(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(a, b);
  return 1.0 - dist / maxLen;
}

/**
 * buildNgrams builds a set of character n-grams from a string.
 */
function buildNgrams(s: string, n: number): Set<string> {
  const ngrams = new Set<string>();
  for (let i = 0; i <= s.length - n; i++) {
    ngrams.add(s.slice(i, i + n));
  }
  return ngrams;
}

/**
 * ngramOverlap computes the character n-gram overlap coefficient between two strings.
 * Returns |intersection(ngrams(a), ngrams(b))| / min(|ngrams(a)|, |ngrams(b)|).
 */
export function ngramOverlap(a: string, b: string, n: number): number {
  if (n <= 0) throw new Error(`ngramOverlap: n must be positive, got ${n}`);
  if (a.length < n || b.length < n) return 0;

  const ngramsA = buildNgrams(a, n);
  const ngramsB = buildNgrams(b, n);

  let intersection = 0;
  for (const ng of ngramsA) {
    if (ngramsB.has(ng)) {
      intersection++;
    }
  }

  const minSize = Math.min(ngramsA.size, ngramsB.size);
  if (minSize === 0) return 0;

  return intersection / minSize;
}

/**
 * confidenceBand returns the confidence band label for a given score.
 */
export function confidenceBand(score: number): 'high' | 'medium' | 'speculative' | '' {
  if (score >= 0.7) return 'high';
  if (score >= 0.45) return 'medium';
  if (score >= 0.25) return 'speculative';
  return '';
}
