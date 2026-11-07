const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

// OSC (ESC ] ... BEL | ESC \) and CSI (ESC [ ... final byte).
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const OTHER_ESC = new RegExp(`${ESC}[@-Z\\\\-_]`, 'g')

export function stripAnsi(line: string): string {
  return line.replace(OSC, '').replace(CSI, '').replace(OTHER_ESC, '').trim()
}

/**
 * The marker Claude Code puts next to the highlighted choice. ASCII ">" is
 * deliberately NOT accepted: it starts quoted lines, diffs and shell prompts in
 * ordinary output, which is exactly the content an attacker can influence.
 */
const SELECTION_MARKER = /^[❯▶]\s+\S/
const CONFIRM_HINT = /enter\b[^\n]*\b(confirm|подтверд)|esc\b[^\n]*\b(cancel|отмен)/i

/** How far above the bottom of the viewport a real prompt can start. */
const PROMPT_ZONE_ROWS = 15

function markerIndexIn(lines: string[]): number {
  const at = lines.findIndex((line) => SELECTION_MARKER.test(line))
  if (at === -1) return -1
  // Claude Code draws its prompts at the bottom of the screen. A marker in the
  // middle of a long scroll is output being quoted, not a prompt.
  return at < lines.length - PROMPT_ZONE_ROWS ? -1 : at
}

function cleaned(visibleLines: string[]): string[] {
  return visibleLines.map(stripAnsi).filter((line) => line !== '')
}

/**
 * The looser signal, used only to decide where the arrow keys go.
 *
 * Being wrong here costs the user one keystroke — arrows reach the agent
 * instead of their own history — so it does not require the confirmation hint
 * that detectMenu insists on. That strictness was tuned against the one prompt
 * shape a probe captured; a real permission prompt laid out differently must
 * still be navigable.
 */
export function detectMenuLikely(visibleLines: string[]): boolean {
  const lines = cleaned(visibleLines)
  const at = markerIndexIn(lines)
  if (at === -1) return false
  // A marked line plus at least one sibling beneath it: one marked line alone
  // is a prompt, not a choice.
  return lines[at + 1] !== undefined
}

/**
 * Recognises the moment the agent is showing an arrow-driven menu, so focus can
 * move to the terminal on its own (spec 6.4, mechanism 3).
 *
 * This is convenience, not load-bearing: the explicit Ctrl+` toggle and the
 * empty-field key rules work whether or not this returns the right answer, and
 * it can be switched off in settings. So it is deliberately strict — a missed
 * menu costs one keystroke, a false positive steals focus mid-sentence.
 */
export function detectMenu(visibleLines: string[]): boolean {
  const lines = cleaned(visibleLines)
  const markerIndex = markerIndexIn(lines)
  if (markerIndex === -1) return false

  // The confirmation hint is required, and it has to sit below the marker —
  // text that merely mentions it (a file being read aloud) does not count.
  return lines.slice(markerIndex + 1).some((line) => CONFIRM_HINT.test(line))
}
