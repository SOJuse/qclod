/**
 * The instruction a message to a subagent travels in (stage 4, decision 5) —
 * written in main, and recognised again by the ribbon when a past
 * conversation is read back. One place for both, so they cannot drift apart.
 */

const HEAD = 'Передай агенту '
const VIA = ' через SendMessage (to: "'
const TAIL = '") это сообщение от пользователя, дословно:\n\n'

/**
 * What the main agent is told. «от пользователя» is there on purpose: a
 * model once took a relayed message for an injection (park P1 of stage 1).
 */
export function relayInstruction(ref: string, text: string): string {
  return `${HEAD}${ref}${VIA}${ref}${TAIL}${text}`
}

/**
 * The address and the person's words of an instruction made by
 * relayInstruction; null for anything else — not the exact template, the two
 * addresses differ, or nothing to pass on.
 */
export function parseRelayInstruction(raw: string): { ref: string; text: string } | null {
  if (!raw.startsWith(HEAD)) return null
  const tailAt = raw.indexOf(TAIL)
  if (tailAt === -1) return null
  const head = raw.slice(HEAD.length, tailAt)
  const via = head.indexOf(VIA)
  if (via === -1) return null
  const ref = head.slice(0, via)
  if (ref === '' || head.slice(via + VIA.length) !== ref) return null
  const text = raw.slice(tailAt + TAIL.length)
  if (text.trim() === '') return null
  return { ref, text }
}
