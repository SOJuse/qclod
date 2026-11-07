import { physicalKey, type PhysicalKeyEvent } from '../input/physicalKey'

export type TerminalKeyAction =
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'search'
  | 'clear'
  | 'fontUp'
  | 'fontDown'
  | 'fontReset'
  | 'toggleFocus'
  | 'toPty'

export interface TerminalKeyContext {
  hasSelection: boolean
}

export interface KeyLike extends PhysicalKeyEvent {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * Makes the terminal behave like a normal Windows app for editing keys while
 * leaving everything else to the agent (spec 6.5). Rules are checked in order;
 * the first match wins.
 */
export function resolveTerminalKey(ev: KeyLike, ctx: TerminalKeyContext): TerminalKeyAction {
  if (!ev.ctrlKey || ev.altKey || ev.metaKey) return 'toPty'

  const key = physicalKey(ev)

  if (key === '`') return 'toggleFocus'

  if (key === 'c') {
    // Ctrl+C only interrupts when there is nothing to copy — the single most
    // common papercut of running the CLI in a stock terminal.
    if (ev.shiftKey || ctx.hasSelection) return 'copy'
    return 'toPty'
  }

  if (key === 'v') return 'paste'
  if (key === 'a') return 'selectAll'
  if (key === 'f') return 'search'
  if (key === 'l') return 'clear'
  if (key === '+' || key === '=') return 'fontUp'
  if (key === '-' || key === '_') return 'fontDown'
  if (key === '0') return 'fontReset'

  return 'toPty'
}
