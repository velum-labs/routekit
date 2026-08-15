/**
 * Tiny name-suggestion helper for closed-set "did you mean" hints. Given a
 * mistyped candidate and the known names it should have matched, return the
 * single closest known name by Levenshtein edit distance — but only when the
 * match is near enough to be a plausible typo rather than an unrelated word.
 *
 * Used by the feature loader to turn an unrecognized `feature.ts` export
 * (e.g. `harnes`, `Harness`, `chatClient`) into an actionable hint pointing at
 * the closed export set, without pulling in a dependency for a few lines of
 * code the repo can own.
 */

/** Maximum edit distance, as a fraction of the longer string, to still suggest. */
const MAX_DISTANCE_RATIO = 0.5;

/**
 * Levenshtein edit distance between two strings using a single rolling row.
 * O(a.length * b.length) time, O(b.length) space — fine for the short
 * identifiers this is used on.
 */
export const editDistance = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  let previousRow = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i += 1) {
    const currentRow = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      const substitutionCost = a[i] === b[j] ? 0 : 1;
      const insertion = currentRow[j] + 1;
      const deletion = previousRow[j + 1] + 1;
      const substitution = previousRow[j] + substitutionCost;
      currentRow.push(Math.min(insertion, deletion, substitution));
    }
    previousRow = currentRow;
  }
  return previousRow[b.length];
};

/**
 * Return the closest name in `known` to `candidate`, or `undefined` when none
 * is close enough to be a plausible typo. A case-insensitive exact match is
 * always returned first (covers wrong-case typos like `Harness` for `harness`).
 * Ties resolve to the first candidate in `known` order, keeping the result
 * deterministic for a stable closed set.
 */
export const nearestName = (
  candidate: string,
  known: readonly string[]
): string | undefined => {
  const lowerCandidate = candidate.toLowerCase();
  const caseInsensitiveMatch = known.find(
    (name) => name.toLowerCase() === lowerCandidate
  );
  if (caseInsensitiveMatch !== undefined) {
    return caseInsensitiveMatch;
  }

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of known) {
    const distance = editDistance(candidate, name);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }

  if (best === undefined) {
    return undefined;
  }
  const longest = Math.max(candidate.length, best.length);
  return bestDistance <= longest * MAX_DISTANCE_RATIO ? best : undefined;
};
