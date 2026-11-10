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
  /** Only ever resolved for the permission card while it has focus (ruling C16). */
  | 'permissionAllow'
  | 'permissionAllowAll'
  | 'permissionDeny'
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
  /** No line break before the caret: ↑ has nowhere to go inside the text. */
  caretOnFirstLine: boolean
  /** No line break after the caret: ↓ has nowhere to go inside the text. */
  caretOnLastLine: boolean
  /**
   * The keys of a permission card are being resolved. Set by the card while IT
   * has focus, never by the input line: a reply that starts with «ф» (KeyA on
   * the Russian layout) must not grant a blanket permission (ruling C16).
   */
  pendingPermission?: boolean
}

export interface KeyLike extends PhysicalKeyEvent {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  /** True while an IME is composing a character; its keys belong to it. */
  isComposing?: boolean
  /** 229 is what the browser reports for a key the IME has taken. */
  keyCode?: number
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
  // An input method is composing: Enter confirms its candidate, Esc cancels
  // it. Taking either as ours would send half a word or interrupt the agent.
  (ev) => (ev.isComposing || ev.keyCode === 229 ? 'native' : undefined),

  // Esc must always reach the agent, or a half-typed draft would make it
  // uninterruptible. With a popup open it closes the popup first.
  (ev, ctx) => {
    if (ev.key !== 'Escape') return undefined
    if (ctx.popupOpen) return 'closePopup'
    return ctx.pendingPermission ? 'permissionDeny' : 'interrupt'
  },

  // A permission card with focus: Enter allows, A allows all of the kind. Only
  // on an empty field without attachments — with text, Enter is a send.
  (ev, ctx) =>
    ctx.pendingPermission &&
    ev.key === 'Enter' &&
    !ev.shiftKey &&
    ctx.text === '' &&
    !ctx.hasAttachments
      ? 'permissionAllow'
      : undefined,
  (ev, ctx) =>
    ctx.pendingPermission &&
    ctx.text === '' &&
    !ev.ctrlKey &&
    !ev.altKey &&
    !ev.metaKey &&
    !ev.shiftKey &&
    physicalKey(ev) === 'a'
      ? 'permissionAllowAll'
      : undefined,

  // Native editing. The field is a plain textarea and the browser does these
  // correctly; intercepting them is how undo gets broken.
  (ev) =>
    (ev.ctrlKey || ev.metaKey) && !ev.altKey && NATIVE_KEYS.has(physicalKey(ev))
      ? 'native'
      : undefined,

  // Our list owns Tab, Enter and the arrows while it is open.
  // Shift+Enter is still a line break.
  (ev, ctx) => (ctx.popupOpen && ev.key === 'Enter' && !ev.shiftKey ? 'popupAccept' : undefined),
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

  // Vertical arrows: history on the first / last line, caret movement inside.
  // A selection is the person working on the text, not asking for the past.
  (ev, ctx) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return undefined
    if (ctx.hasSelection) return 'caret'
    const atEdge = ev.key === 'ArrowUp' ? ctx.caretOnFirstLine : ctx.caretOnLastLine
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
