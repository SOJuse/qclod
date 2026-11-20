import { score } from '../../shared/commandFilter'
import { SECTION_CAP } from './types'

/** Text as the search compares it: lower case, «ё» read as «е». */
export function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е')
}

/** How well a short text (a title, a name, a path) fits the needle, by its letters in order; null — not at all. */
export function points(text: string, needle: string): number | null {
  return score(fold(text), needle)
}

/**
 * A long text (a first message) is found by a piece of it, not by letters
 * scattered across it — those would fit almost any needle. Below any title match.
 */
export function contains(text: string, needle: string): number | null {
  return fold(text).includes(needle) ? 0 : null
}

/** The best of several fields; null when none fits. */
export function bestOf(...all: Array<number | null>): number | null {
  let best: number | null = null
  for (const p of all) if (p !== null && (best === null || p > best)) best = p
  return best
}

/** What fits, best first, the given order kept among equals; at most SECTION_CAP. */
export function ranked<T>(all: readonly T[], pointsOf: (item: T) => number | null): T[] {
  const fit: Array<{ item: T; p: number; order: number }> = []
  all.forEach((item, order) => {
    const p = pointsOf(item)
    if (p !== null) fit.push({ item, p, order })
  })
  fit.sort((a, b) => b.p - a.p || a.order - b.order)
  return fit.slice(0, SECTION_CAP).map((f) => f.item)
}
