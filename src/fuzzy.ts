/**
 * Subsequence fuzzy match: returns a score (higher is better) if every char of `query` appears in
 * `text` in order, else -1. Consecutive and start-of-word matches score higher, so "rdm" ranks
 * "Readme" above "Random Draft Meeting". Case-insensitive.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === ch) { found = j; break; }
    }
    if (found === -1) return -1;
    score += 1;
    if (found === prevMatch + 1) score += 2; // consecutive
    if (found === 0 || /\W|_|\//.test(t[found - 1])) score += 3; // word boundary
    prevMatch = found;
    ti = found + 1;
  }
  // Prefer shorter targets and earlier first matches.
  return score - text.length * 0.01;
}
