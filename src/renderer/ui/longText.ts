/**
 * Long text without line breaks (task 9b). Blink lays a paragraph out line by
 * line, and each line walks the paragraph's shaped runs from the start. Inter
 * comes in per-script files (@fontsource cuts it by unicode-range), so a
 * Russian paragraph changes font file at every space and has a run per word:
 * the layout grows with lines × runs, about 20 s for 200 000 characters.
 * A line break ends a paragraph, so text with lines is fast.
 *
 * What is done about it, none of which drops a character:
 * - the field lays such a paragraph out on one line (scrolls sideways): one
 *   line costs one walk;
 * - the ribbon's bubble shows the text as pieces, each its own text node, so
 *   a line only walks the runs of its own piece;
 * - a long Russian text in either takes its spaces from Inter's Cyrillic
 *   file too, so it has a handful of runs instead of two per word.
 * Measured: 200 000 characters went from ~20 s to under 0.6 s (task 9b report).
 */

/** A paragraph longer than this is not wrapped in the field. */
export const LONG_PARAGRAPH = 10_000

/** About how long a piece of a long bubble is. */
export const PIECE = 2000

/** Whether some paragraph of the text (between line breaks) is longer than `limit`. */
export function hasLongParagraph(text: string, limit = LONG_PARAGRAPH): boolean {
  if (text.length <= limit) return false
  let start = 0
  for (;;) {
    const end = text.indexOf('\n', start)
    const stop = end === -1 ? text.length : end
    if (stop - start > limit) return true
    if (end === -1) return false
    start = end + 1
  }
}

/**
 * More Cyrillic letters than Latin ones. Such a long text takes its spaces
 * from Inter's Cyrillic file too (styles/longText.css, --font-long-cyrillic):
 * one file for the words and the spaces between them, far fewer runs to shape.
 * Latin text keeps the usual faces, where its spaces already are.
 */
export function mostlyCyrillic(text: string): boolean {
  let balance = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0x0400 && c <= 0x04ff) balance++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) balance--
  }
  return balance > 0
}

/**
 * The field's extra classes for its text: `is-long` (unwrapped) past
 * LONG_PARAGRAPH, plus `is-cyrillic` (the Cyrillic face) when it is Russian.
 */
export function longFieldClasses(text: string): string[] {
  if (!hasLongParagraph(text)) return []
  return mostlyCyrillic(text) ? ['is-long', 'is-cyrillic'] : ['is-long']
}

const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0xa0

/**
 * Not between the two halves of a surrogate pair, before a combining mark
 * (the stress mark U+0301 in Russian), or around a zero-width joiner.
 */
function canCutAt(text: string, at: number): boolean {
  const code = text.charCodeAt(at)
  if (code >= 0xdc00 && code <= 0xdfff) return false
  if (code === 0x200d || text.charCodeAt(at - 1) === 0x200d) return false
  return !/\p{M}/u.test(String.fromCodePoint(text.codePointAt(at) ?? 0))
}

/**
 * The text cut into pieces of at most `size` characters, each ending after a
 * space where one is near the end. `pieces.join('') === text` always.
 */
export function textPieces(text: string, size = PIECE): string[] {
  if (text.length <= size) return [text]
  const pieces: string[] = []
  let start = 0
  while (text.length - start > size) {
    const end = start + size
    const floor = start + Math.floor((size * 3) / 4)
    let cut = -1
    for (let i = end; i > floor; i--) {
      if (isSpace(text.charCodeAt(i - 1))) {
        cut = i
        break
      }
    }
    if (cut === -1) {
      cut = end
      while (cut > start + 1 && !canCutAt(text, cut)) cut--
    }
    pieces.push(text.slice(start, cut))
    start = cut
  }
  pieces.push(text.slice(start))
  return pieces
}
