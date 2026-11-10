/**
 * What a tool card is allowed to keep of a call.
 *
 * A tool's input and structured output travel to the window and sit in the
 * ribbon for the life of the tab. A build log of a megabyte, a file read in
 * full or a page of base64 must not: the card stores a bounded copy.
 *
 * Three bounds, each for a different shape of excess: one string (VIEW_CLIP),
 * one array (500 items) and nesting (6 levels) — and, over all of them, a
 * budget for the whole value (VIEW_TOTAL), since 500 x 500 x 20k is not small.
 */

/** The most characters a single string keeps in a card. */
export const VIEW_CLIP = 20_000

/**
 * The most characters one clipped value keeps in all: strings plus a nominal
 * cost per key and array item, so a million empty strings do not pass either.
 * Past it, strings are cut to nothing but their «обрезано» note.
 */
export const VIEW_TOTAL = 200_000

const MAX_ITEMS = 500
const MAX_DEPTH = 6
/** What a key or an array item costs the budget, whatever it holds. */
const NODE_COST = 16

/** Keys that are never useful on a card and can weigh megabytes. */
const DROPPED_KEYS = new Set(['originalFile'])

/** The first `keep` characters, with a note of how many were left out. */
function cut(text: string, keep: number): string {
  return keep < text.length ? `${text.slice(0, keep)}…[обрезано: ${text.length - keep} символов]` : text
}

interface Budget {
  left: number
}

function clipValue(
  value: unknown,
  maxChars: number,
  depth: number,
  parentKey: string,
  budget: Budget
): unknown {
  if (typeof value === 'string') {
    const keep = Math.max(0, Math.min(maxChars, budget.left, value.length))
    budget.left -= keep
    return cut(value, keep)
  }
  if (typeof value !== 'object' || value === null) return value
  if (depth >= MAX_DEPTH) return '…[глубже шести уровней]'

  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const v of value.slice(0, MAX_ITEMS)) {
      if (budget.left <= 0) break
      budget.left -= NODE_COST
      out.push(clipValue(v, maxChars, depth + 1, parentKey, budget))
    }
    return out
  }

  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key)) continue
    // FileReadOutput's image: the picture itself is not shown on a card.
    if (key === 'base64' && parentKey === 'file') continue
    if (budget.left <= 0) break
    budget.left -= NODE_COST
    out[key] = clipValue(inner, maxChars, depth + 1, key, budget)
  }
  return out
}

/**
 * A copy of `value` that is safe to keep on a card: long strings cut with a
 * note of how much was left out, arrays at 500 items, nesting at 6 levels,
 * `originalFile` and `file.base64` gone, and no more than `totalChars` in all.
 * The argument is not modified.
 */
export function clipForView(value: unknown, maxChars = VIEW_CLIP, totalChars = VIEW_TOTAL): unknown {
  return clipValue(value, maxChars, 0, '', { left: totalChars })
}

/** One string, bounded the same way as clipForView, and typed as the string it stays. */
export function clipText(text: string, maxChars = VIEW_CLIP): string {
  return cut(text, Math.max(0, maxChars))
}
