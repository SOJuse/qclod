const NO_SPACE_BEFORE = /^[,.!?:;)…]/
const SENTENCE_END = /[.!?…]$/

/**
 * A dictated phrase goes into the draft at the caret: spaces are mended on
 * both sides, a phrase that continues a sentence starts in lower case, and the
 * caret stands right after the inserted text.
 */
export function insertDictated(
  draft: string,
  caret: number,
  text: string,
  opts?: { joinsPrevious?: boolean }
): { draft: string; caret: number } {
  const at = Math.max(0, Math.min(Number.isFinite(caret) ? Math.trunc(caret) : 0, draft.length))
  let phrase = text.trim()
  if (phrase === '') return { draft, caret: at }

  const left = draft.slice(0, at)
  const right = draft.slice(at)
  const leftTrimmed = left.replace(/\s+$/, '')
  const sentenceStart =
    leftTrimmed === '' || SENTENCE_END.test(leftTrimmed) || /\n\s*$/.test(left)

  const continues = opts?.joinsPrevious === true || !sentenceStart
  const chars = Array.from(phrase)
  if (
    continues &&
    /^[\u0400-\u04FF]/.test(chars[0]) &&
    chars.length > 1 &&
    /^\p{Ll}$/u.test(chars[1])
  ) {
    chars[0] = chars[0].toLowerCase()
    phrase = chars.join('')
  }

  const spaceBefore = left !== '' && !/\s$/.test(left) && !NO_SPACE_BEFORE.test(phrase) ? ' ' : ''
  const spaceAfter = /^[\p{L}\p{N}]/u.test(right) ? ' ' : ''
  const inserted = spaceBefore + phrase
  return {
    draft: left + inserted + spaceAfter + right,
    caret: left.length + inserted.length
  }
}
