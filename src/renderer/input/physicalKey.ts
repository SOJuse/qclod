export interface PhysicalKeyEvent {
  key: string
  /** KeyboardEvent.code — the physical key, independent of layout. */
  code?: string
}

const CODE_TO_CHAR: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  NumpadAdd: '+',
  NumpadSubtract: '-'
}

/**
 * The letter a shortcut should be matched against, independent of keyboard
 * layout.
 *
 * `KeyboardEvent.key` carries the character the ACTIVE layout produces: with
 * the Russian layout selected, Ctrl+V arrives as key='м' and Ctrl+` as key='ё'.
 * Matching shortcuts on `key` therefore disables every one of them for exactly
 * the people this app is written for. `code` names the physical key and does
 * not move.
 *
 * Only shortcuts use this. Characters the user is typing — the "/" that starts
 * a slash command, for instance — must keep using `key`, because those are
 * about the character produced, not the key pressed.
 */
export function physicalKey(ev: PhysicalKeyEvent): string {
  const code = ev.code
  if (code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
    if (/^Digit[0-9]$/.test(code)) return code.slice(5)
    const mapped = CODE_TO_CHAR[code]
    if (mapped !== undefined) return mapped
  }
  return ev.key.toLowerCase()
}
