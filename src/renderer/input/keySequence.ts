/**
 * The ESC byte, built from its code point rather than written as a literal:
 * a raw control character in a source file is invisible and easy to mangle.
 */
export const ESC = String.fromCharCode(27)
const DEL = String.fromCharCode(127)

export interface KeySequenceInput {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const NAMED: Record<string, string> = {
  Escape: ESC,
  Enter: '\r',
  Backspace: DEL,
  Delete: `${ESC}[3~`,
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  ArrowRight: `${ESC}[C`,
  ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[H`,
  End: `${ESC}[F`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`
}

/** Translates a key event into the bytes a terminal would have sent. */
export function toSequence(ev: KeySequenceInput): string {
  if (ev.key === 'Tab') return ev.shiftKey ? `${ESC}[Z` : '\t'

  const named = NAMED[ev.key]
  if (named !== undefined) return named

  if (ev.ctrlKey && ev.key.length === 1) {
    const code = ev.key.toUpperCase().charCodeAt(0)
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
  }

  return ev.key.length === 1 ? ev.key : ''
}
