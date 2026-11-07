import { physicalKey, type PhysicalKeyEvent } from './physicalKey'

export type ComposerKeyAction =
  | 'toPty'
  | 'toggleFocus'
  | 'paste'
  | 'copy'
  | 'closePopup'
  | 'popupNav'
  | 'popupAccept'
  | 'submit'
  | 'newline'
  | 'historyPrev'
  | 'historyNext'
  | 'caret'
  | 'insert'

export interface ComposerContext {
  text: string
  /** The line starts with "/" — keystrokes go straight to the CLI. */
  passthrough: boolean
  /** The composer's own @-mention popup is open. */
  popupOpen: boolean
  /** The agent is showing an arrow-driven menu in the terminal. */
  menuActive: boolean
  hasSelection: boolean
  caretAtStart: boolean
  caretAtEnd: boolean
}

export interface KeyLike extends PhysicalKeyEvent {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

type Rule = (ev: KeyLike, ctx: ComposerContext) => ComposerKeyAction | undefined

/**
 * Spec 6.4's precedence table, as an ordered list. The order IS the priority:
 * the first rule that returns an action wins, and nothing is decided by nested
 * conditions elsewhere. Anti-goal 2 ("fragile magic") is why this is one
 * readable list with a test per row.
 */
const RULES: Rule[] = [
  // Esc must always reach the agent, or a half-typed draft would make the
  // agent uninterruptible. With our own popup open it closes the popup first.
  (ev, ctx) => (ev.key === 'Escape' ? (ctx.popupOpen ? 'closePopup' : 'toPty') : undefined),

  // The always-available manual escape hatch.
  (ev) => (ev.ctrlKey && physicalKey(ev) === '`' ? 'toggleFocus' : undefined),

  (ev) => (ev.ctrlKey && !ev.altKey && physicalKey(ev) === 'v' ? 'paste' : undefined),
  (ev, ctx) =>
    ev.ctrlKey && !ev.altKey && physicalKey(ev) === 'c'
      ? ctx.hasSelection || ev.shiftKey
        ? 'copy'
        : 'toPty'
      : undefined,

  // Our popup owns Tab/Enter/arrows while it is open.
  (ev, ctx) => (ctx.popupOpen && (ev.key === 'Tab' || ev.key === 'Enter') ? 'popupAccept' : undefined),
  (ev, ctx) =>
    ctx.popupOpen && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') ? 'popupNav' : undefined,

  // Shift+Tab / Tab switch the agent's modes.
  (ev) => (ev.key === 'Tab' ? 'toPty' : undefined),

  // The "/" that turns passthrough on must itself reach the CLI, or the
  // command would arrive one character short.
  (ev, ctx) =>
    ev.key === '/' && ctx.text === '' && !ev.ctrlKey && !ev.altKey ? 'toPty' : undefined,

  // In passthrough the text lives in the CLI, so editing keys belong to it too.
  (_ev, ctx) => (ctx.passthrough ? 'toPty' : undefined),

  (ev) => (ev.key === 'Enter' && ev.shiftKey ? 'newline' : undefined),
  (ev, ctx) => (ev.key === 'Enter' ? (ctx.text === '' ? 'toPty' : 'submit') : undefined),

  // Horizontal movement is always just movement inside the field.
  (ev) =>
    ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End'
      ? 'caret'
      : undefined,

  // Vertical arrows: menu navigation, history, or caret movement.
  (ev, ctx) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return undefined
    if (ctx.text === '' && ctx.menuActive) return 'toPty'
    const atEdge = ev.key === 'ArrowUp' ? ctx.caretAtStart : ctx.caretAtEnd
    if (!atEdge) return 'caret'
    return ev.key === 'ArrowUp' ? 'historyPrev' : 'historyNext'
  }
]

export function resolveComposerKey(ev: KeyLike, ctx: ComposerContext): ComposerKeyAction {
  for (const rule of RULES) {
    const action = rule(ev, ctx)
    if (action !== undefined) return action
  }
  return 'insert'
}
