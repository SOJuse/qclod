import { useEffect, useRef } from 'react'
import { Check, CheckCheck, X } from 'lucide-react'
import type { RibbonItem } from '../../shared/types'
import { resolveComposerKey } from '../input/keyPrecedence'
import {
  arrivalOf,
  claimFocusOffer,
  createKeyGuard,
  focusedLongEnough,
  heldKeys,
  trackHeldKeys,
  windowFocusedSince
} from '../chat/permissionKeyGuard'

trackHeldKeys()

type Permission = Extract<RibbonItem, { kind: 'permission' }>

/** How a closed card reads; «elsewhere» was answered on the phone or claude.ai. */
const DONE_LABEL: Record<Permission['state'], string> = {
  pending: '',
  allowed: 'разрешено',
  denied: 'отклонено',
  elsewhere: 'ответили с телефона или claude.ai'
}

interface Props {
  item: Permission
  /** The earliest question still waiting: the one that takes focus and the keys. */
  active?: boolean
  onAnswer: (requestId: string, behavior: 'allow' | 'deny', remember?: boolean) => void
}

/**
 * Whether the card may take focus. Only when the window has been in front for
 * a while before the request came, the pane is the one being worked in, no
 * dialog, sheet or palette is open, and focus rests on nothing, on this pane's
 * empty input line, or inside this pane's ribbon. Anything else — another
 * pane, a settings control, a draft — is where the person is, and the card
 * just shows.
 */
function mayTakeFocus(card: HTMLElement, arrivedAt: number): boolean {
  if (!document.hasFocus() || !focusedLongEnough(windowFocusedSince(), arrivedAt)) return false
  const pane = card.closest('[data-testid="chat-pane"]')
  if (!pane?.classList.contains('is-focused')) return false
  if (
    document.querySelector(
      '[role="dialog"], [aria-modal="true"], [data-testid="settings"], [data-testid="action-palette"]'
    )
  ) {
    return false
  }
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || el === document.body) return true
  if (el instanceof HTMLTextAreaElement && el.hasAttribute('data-composer-input')) {
    return pane.contains(el) && el.value === ''
  }
  return !!el.closest('[data-testid="ribbon"]') && pane.contains(el)
}

/**
 * The agent wants to use a tool and is waiting.
 *
 * It sits in the ribbon where the tool's own card will go, rather than in a
 * modal over everything: the question belongs in the story at the point it was
 * asked, and v1's guessing at a menu the CLI drew is gone for good (spec 6.4).
 *
 * Enter, A and Esc answer it, but only while the card itself has focus. The
 * card takes focus when it appears, unless the person is in the middle of a
 * reply: a message that starts with «ф» (A on the Russian layout) must never
 * grant a blanket permission.
 */
export function PermissionCard({ item, active = false, onAnswer }: Props): JSX.Element {
  const card = useRef<HTMLDivElement | null>(null)
  const guard = useRef(createKeyGuard())
  /** When the question came — first shown, not this mount; the window must have been in front before that. */
  const arrivedAt = arrivalOf(item.requestId, performance.now())
  /** A Space key-down was refused, so its key-up must not click the button. */
  const spaceRefused = useRef(false)
  useEffect(() => {
    const own = guard.current
    return () => own.dispose()
  }, [])
  const pending = item.state === 'pending'
  const takesFocus = pending && active

  useEffect(() => {
    if (!takesFocus) return
    // After the other effects of this commit: a tab switch hands focus to the
    // input line in one of them, and the card asks only after that.
    const timer = setTimeout(() => {
      const el = card.current
      // Offered once per request: a remount (scrolled back, tab shown again)
      // must not pull focus from wherever the person has gone since.
      if (!el || !claimFocusOffer(item.requestId)) return
      if (!mayTakeFocus(el, arrivedAt)) return
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    }, 0)
    return () => clearTimeout(timer)
  }, [takesFocus, item.requestId, arrivedAt])

  function answer(behavior: 'allow' | 'deny', remember?: boolean): void {
    // Focus goes back to the input line, so the next thing typed lands there
    // and not on a card that has been answered.
    const hadFocus = card.current?.contains(document.activeElement) ?? false
    const pane = card.current?.closest('[data-testid="chat-pane"]')
    onAnswer(item.requestId, behavior, remember)
    if (hadFocus) {
      pane?.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus()
    }
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLDivElement>): void {
    if (!pending) return
    // A button would click itself on Enter and Space: held, repeating, chorded
    // or too-early presses are stopped before it can.
    if (ev.target instanceof HTMLButtonElement && (ev.key === 'Enter' || ev.key === ' ')) {
      const refused =
        ev.repeat ||
        ev.ctrlKey ||
        ev.altKey ||
        ev.metaKey ||
        !guard.current.allows(ev.code || ev.key, performance.now())
      if (refused) {
        ev.preventDefault()
        ev.stopPropagation()
        if (ev.key === ' ') spaceRefused.current = true
      } else if (ev.key === ' ') {
        spaceRefused.current = false
      }
      return
    }
    if (!takesFocus) return
    // Held, auto-repeating or chorded keys, and keys still in flight when the
    // card appeared, never answer: only a fresh plain press after it is armed.
    if (ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey) return
    if (!guard.current.allows(ev.code || ev.key, performance.now())) return
    const action = resolveComposerKey(
      {
        key: ev.key,
        code: ev.code,
        ctrlKey: ev.ctrlKey,
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
        isComposing: ev.nativeEvent.isComposing,
        keyCode: ev.keyCode
      },
      {
        text: '',
        popupOpen: false,
        hasSelection: false,
        caretOnFirstLine: true,
        caretOnLastLine: true,
        pendingPermission: true
      }
    )
    // On a button, Enter is that button's own click.
    if (action === 'permissionAllow' && ev.target instanceof HTMLButtonElement) return
    if (action === 'permissionAllow') answer('allow')
    else if (action === 'permissionAllowAll') answer('allow', true)
    else if (action === 'permissionDeny') answer('deny')
    else return
    ev.preventDefault()
    ev.stopPropagation()
  }

  return (
    <div
      ref={card}
      className={`row-permission is-${item.state}`}
      data-testid="permission-card"
      tabIndex={pending ? -1 : undefined}
      onFocus={(ev) => {
        // Focus arriving from outside arms the keys afresh, however it came.
        if (!ev.currentTarget.contains(ev.relatedTarget)) {
          guard.current.focus(performance.now(), heldKeys())
        }
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(ev) => {
        if (ev.key !== ' ' || !spaceRefused.current) return
        spaceRefused.current = false
        ev.preventDefault()
      }}
    >
      <div className="row-permission-head">
        <strong>{item.toolName}</strong>
        <span className="row-permission-target">{item.target}</span>
      </div>
      {pending ? (
        <div className="row-permission-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="permission-allow"
            title="Разрешить (Enter)"
            onClick={() => answer('allow')}
          >
            <Check size={14} aria-hidden="true" />
            Разрешить
            <kbd>Enter</kbd>
          </button>
          <button
            type="button"
            className="btn"
            data-testid="permission-allow-all"
            title="Разрешить всё такое (A)"
            onClick={() => answer('allow', true)}
          >
            <CheckCheck size={14} aria-hidden="true" />
            Разрешить всё такое
            <kbd>A</kbd>
          </button>
          <button
            type="button"
            className="btn btn-danger"
            data-testid="permission-deny"
            title="Отклонить (Esc)"
            onClick={() => answer('deny')}
          >
            <X size={14} aria-hidden="true" />
            Отклонить
            <kbd>Esc</kbd>
          </button>
        </div>
      ) : (
        <div className="row-permission-done">
          {DONE_LABEL[item.state]}
        </div>
      )}
    </div>
  )
}
