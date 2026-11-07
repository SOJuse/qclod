const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

// OSC (ESC ] ... BEL | ESC \) and CSI (ESC [ ... final byte).
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const OTHER_ESC = new RegExp(`${ESC}[@-Z\\\\-_]`, 'g')

export function stripAnsi(line: string): string {
  return line.replace(OSC, '').replace(CSI, '').replace(OTHER_ESC, '').trim()
}

/** The marker Claude Code puts next to the highlighted choice. */
const SELECTION_MARKER = /^[❯▶>]\s+\S/
const CONFIRM_HINT = /enter\b[^\n]*\b(confirm|подтверд)|esc\b[^\n]*\b(cancel|отмен)/i
const OPTION_LINE = /^(?:[❯▶>]\s+)?(?:\d+[.)]\s+)?\S/

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

  if (lines.some((line) => CONFIRM_HINT.test(line))) return true

  // No hint line visible: accept it only if the marked line has at least one
  // sibling choice right beneath it.
  const sibling = lines[markerIndex + 1]
  return sibling !== undefined && OPTION_LINE.test(sibling) && !CONFIRM_HINT.test(sibling)
}
