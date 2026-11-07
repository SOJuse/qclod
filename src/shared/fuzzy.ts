const DEFAULT_RESULTS = 30

/**
 * Subsequence ("fuzzy") match, so `sam` finds `src/app/main.ts`. Ranked by how
 * tightly the query sits in the path, with the file name weighted over folders.
 */
export function filterPaths(
  index: string[],
  query: string,
  limit: number = DEFAULT_RESULTS
): string[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return index.slice(0, Math.max(limit, index.length))

  const scored: Array<{ path: string; score: number }> = []
  for (const path of index) {
    const score = scorePath(path.toLowerCase(), needle)
    if (score !== null) scored.push({ path, score })
  }

  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return scored.slice(0, limit).map((entry) => entry.path)
}

function scorePath(path: string, needle: string): number | null {
  const name = path.slice(path.lastIndexOf('/') + 1)

  const inName = subsequenceScore(name, needle)
  if (inName !== null) return inName + 1000 + (name === needle ? 500 : 0)

  const inPath = subsequenceScore(path, needle)
  return inPath
}

function subsequenceScore(haystack: string, needle: string): number | null {
  let at = 0
  let score = 0
  let streak = 0

  for (const ch of needle) {
    const found = haystack.indexOf(ch, at)
    if (found === -1) return null
    streak = found === at ? streak + 1 : 0
    // Consecutive characters and early matches are worth more.
    score += 10 + streak * 5 - Math.min(found - at, 10)
    at = found + 1
  }
  return score
}
