/** What a key-down carries that matters here; React's and the DOM's events both fit. */
interface KeyLike {
  key: string
  repeat: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** Held, auto-repeating or chorded keys never answer a card. */
export function chorded(ev: KeyLike): boolean {
  return ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey
}

const MODIFIERS = new Set(['Alt', 'Control', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'OS'])

/**
 * Keys that say nothing about the card under focus: switching windows, tabs
 * or panes (Alt+Tab, Win, Ctrl+Tab, Ctrl+1…9, Ctrl+K), a bare modifier,
 * moving focus with Tab / Shift+Tab, function keys, auto-repeat. A person
 * doing any of these has not started to answer.
 */
export function passingKey(ev: KeyLike): boolean {
  return chorded(ev) || MODIFIERS.has(ev.key) || ev.key === 'Tab' || /^F([1-9]|1[0-2])$/.test(ev.key)
}
