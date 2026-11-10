import { physicalKey, type PhysicalKeyEvent } from './physicalKey'

export type ComposerKeyAction =
  /** The browser already does it right: paste, undo, select-all, cut, copy. */
  | 'native'
  | 'interrupt'
  | 'closePopup'
  | 'popupNav'
  | 'popupAccept'
  /** Tab on an open list: write the choice into the field, run nothing. */
  | 'popupComplete'
  | 'openMentions'
  | 'cyclePermissionMode'
  | 'submit'
  | 'newline'
  | 'historyPrev'
  | 'historyNext'
  | 'caret'
  | 'insert'

export interface ComposerContext {
  text: string
  /** The list above the input — files after `@`, commands after `/` — is open. */
  popupOpen: boolean
  hasSelection: boolean
  /** A file is attached, so there is something to send even with no text. */
  hasAttachments?: boolean
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

/** Editing shortcuts the field must never intercept. */
const NATIVE_KEYS = new Set(['v', 'z', 'y', 'a', 'x', 'c'])

/**
 * The precedence table, as an ordered list. The order IS the priority: the
 * first rule that returns an action wins, and nothing is decided by nested
 * conditions elsewhere.
 *
 * There is one input line now, and it is ours (spec 6.3), so the whole notion
 * of handing keystrokes to a second field is gone — with it the focus jumping
 * the user called «мега неудобная».
 *
 * Everything matches on the PHYSICAL key, never on `ev.key`: on a Russian
 * layout Ctrl+V reports «м», and a table built on the letter silently stops
 * working the moment someone switches layout.
 */
const RULES: Rule[] = [
  // Esc must always reach the agent, or a half-typed draft would make it
  // uninterruptible. With a popup open it closes the popup first.
  (ev, ctx) => (ev.key === 'Escape' ? (ctx.popupOpen ? 'closePopup' : 'interrupt') : undefined),

  // Native editing. The field is a plain textarea and the browser does these
  // correctly; intercepting them is how undo gets broken.
  (ev) =>
    (ev.ctrlKey || ev.metaKey) && !ev.altKey && NATIVE_KEYS.has(physicalKey(ev))
      ? 'native'
      : undefined,

  // Our list owns Tab, Enter and the arrows while it is open.
  (ev, ctx) => (ctx.popupOpen && ev.key === 'Enter' ? 'popupAccept' : undefined),
  (ev, ctx) => (ctx.popupOpen && ev.key === 'Tab' ? 'popupComplete' : undefined),
  (ev, ctx) =>
    ctx.popupOpen && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') ? 'popupNav' : undefined,

  // Shift+Tab cycles the permission mode, as it does in the terminal.
  (ev) => (ev.key === 'Tab' ? 'cyclePermissionMode' : undefined),

  // A slash is always just typed. The command list opens from the text
  // itself (a slash at the start, see input/slash.ts), right above the field —
  // there is no separate window to jump into.

  (ev) => (ev.key === '@' && !ev.ctrlKey && !ev.altKey ? 'openMentions' : undefined),

  (ev) => (ev.key === 'Enter' && ev.shiftKey ? 'newline' : undefined),
  (ev, ctx) =>
    ev.key === 'Enter'
      ? ctx.text === '' && !ctx.hasAttachments
        ? 'insert'
        : 'submit'
      : undefined,

  // Horizontal movement is always just movement inside the field.
  (ev) =>
    ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End'
      ? 'caret'
      : undefined,

  // Vertical arrows: history at the edges of the text, caret movement inside.
  (ev, ctx) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return undefined
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
