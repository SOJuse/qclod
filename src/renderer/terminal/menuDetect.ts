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
  const lines = visibleLines.map(stripAnsi).filter((line) => line !== '')
  if (lines.length === 0) return false

  const markerIndex = lines.findIndex((line) => SELECTION_MARKER.test(line))
  if (markerIndex === -1) return false

  // Claude Code draws its prompts at the bottom of the screen. A marker in the
  // middle of a long scroll is output being quoted, not a prompt.
  if (markerIndex < lines.length - PROMPT_ZONE_ROWS) return false

  // The confirmation hint is required, and it has to sit below the marker —
  // text that merely mentions it (a file being read aloud) does not count.
  return lines.slice(markerIndex + 1).some((line) => CONFIRM_HINT.test(line))
}
