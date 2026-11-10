/**
 * What a tool card is allowed to keep of a call.
 *
 * A tool's input and structured output travel to the window and sit in the
 * ribbon for the life of the tab. A build log of a megabyte, a file read in
 * full or a page of base64 must not: the card stores a bounded copy.
 */

/** The most characters a single string keeps in a card. */
export const VIEW_CLIP = 20_000

const MAX_ITEMS = 500
const MAX_DEPTH = 6

/** Keys that are never useful on a card and can weigh megabytes. */
const DROPPED_KEYS = new Set(['originalFile'])

function clipValue(value: unknown, maxChars: number, depth: number, parentKey: string): unknown {
  if (typeof value === 'string') {
    return value.length > maxChars
      ? `${value.slice(0, maxChars)}…[обрезано: ${value.length - maxChars} символов]`
      : value
  }
  if (typeof value !== 'object' || value === null) return value
  if (depth >= MAX_DEPTH) return '…[глубже шести уровней]'

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((v) => clipValue(v, maxChars, depth + 1, parentKey))
  }

  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key)) continue
    // FileReadOutput's image: the picture itself is not shown on a card.
    if (key === 'base64' && parentKey === 'file') continue
    out[key] = clipValue(inner, maxChars, depth + 1, key)
  }
  return out
}

/**
 * A copy of `value` that is safe to keep on a card: long strings cut with a
 * note of how much was left out, arrays at 500 items, nesting at 6 levels,
 * `originalFile` and `file.base64` gone. The argument is not modified.
 */
export function clipForView(value: unknown, maxChars = VIEW_CLIP): unknown {
  return clipValue(value, maxChars, 0, '')
}
