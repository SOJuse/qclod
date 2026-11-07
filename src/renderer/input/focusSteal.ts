/** How long after a keystroke the composer keeps the keyboard to itself. */
export const TYPING_GRACE_MS = 1500

export interface FocusStealInput {
  autoFocusOnMenu: boolean
  draft: string
  msSinceTyping: number
}

/**
 * Decides whether a detected menu may take the keyboard.
 *
 * Menu detection reads terminal output, and terminal output is
 * attacker-influenceable — the agent prints file contents, diffs and fetched
 * text. A shape that merely looks like a menu must never be able to pull focus
 * out from under someone mid-sentence, because the keystrokes that follow could
 * answer a real permission prompt. So the transfer only happens when the person
 * clearly is not using the composer right now.
 */
export function shouldStealFocus({
  autoFocusOnMenu,
  draft,
  msSinceTyping
}: FocusStealInput): boolean {
  if (!autoFocusOnMenu) return false
  if (draft.trim() !== '') return false
  return msSinceTyping >= TYPING_GRACE_MS
}
