import { useEffect, useRef, useState } from 'react'
import { Check, CheckCheck, Clock, SendHorizontal, X } from 'lucide-react'
import type { CardAnswers, PermissionChoice } from '../../chat/cardAnswers'
import { createKeyGuard, heldKeys } from '../../chat/permissionKeyGuard'
import { resolveComposerKey } from '../../input/keyPrecedence'
import { CARD_TEXT_MAX, TextCount } from './TextLimit'
import type { PermissionItem } from './types'

interface Props {
  item: PermissionItem
  answers: CardAnswers
  /** The card in front of the strip: its keys answer it. */
  focused: boolean
}

/** Held, auto-repeating or chorded keys never answer. */
function chorded(ev: React.KeyboardEvent): boolean {
  return ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey
}

/**
 * The agent wants to use a tool and is waiting.
 *
 * 1 (and Enter) allows once, 2 allows all of the kind, 3 until the session
 * ends, 4 (and Esc) asks why first — the reason field opens and its Enter
 * sends the refusal, empty or not (decision 8). The keys work only while the
 * card itself has focus, never from the input line or the reason field: a
 * reply that starts with «1» must not grant anything.
 */
export function PermissionCard({ item, answers, focused }: Props): JSX.Element {
  const card = useRef<HTMLDivElement | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  const guard = useRef(createKeyGuard())
  /** A Space key-down was refused, so its key-up must not click the button. */
  const spaceRefused = useRef(false)
  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')
  useEffect(() => {
    const own = guard.current
    return () => own.dispose()
  }, [])
  useEffect(() => {
    if (reasonOpen) field.current?.focus()
  }, [reasonOpen])

  function answer(choice: PermissionChoice): void {
    // Focus goes back to the input line, so the next thing typed lands there
    // and not on a card that has been answered.
    const hadFocus = card.current?.contains(document.activeElement) ?? false
    const pane = card.current?.closest('[data-testid="chat-pane"]')
    answers.permission(item.requestId, choice)
    if (hadFocus) pane?.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus()
  }

  function deny(): void {
    const why = reason.trim()
    answer(why ? { behavior: 'deny', reason: why } : { behavior: 'deny' })
  }

  function openReason(): void {
    if (reasonOpen) field.current?.focus()
    else setReasonOpen(true)
  }

  function closeReason(): void {
    setReasonOpen(false)
    card.current?.focus({ preventScroll: true })
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLDivElement>): void {
    // The reason field keeps its keys: a digit there is text.
    if (ev.target === field.current) return
    // A button would click itself on Enter and Space: held, repeating, chorded
    // or too-early presses are stopped before it can.
    if (ev.target instanceof HTMLButtonElement && (ev.key === 'Enter' || ev.key === ' ')) {
      const refused = chorded(ev) || !guard.current.allows(ev.code || ev.key, performance.now())
      if (refused) {
        ev.preventDefault()
        ev.stopPropagation()
        if (ev.key === ' ') spaceRefused.current = true
      } else if (ev.key === ' ') {
        spaceRefused.current = false
      }
      return
    }
    if (!focused) return
    // Keys still in flight when the card appeared never answer: only a fresh
    // plain press after it is armed.
    if (chorded(ev) || !guard.current.allows(ev.code || ev.key, performance.now())) return
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
    if (action === 'permissionAllow') answer({ behavior: 'allow', scope: 'once' })
    else if (action === 'permissionAllowAll') answer({ behavior: 'allow', scope: 'always' })
    else if (action === 'permissionAllowSession') answer({ behavior: 'allow', scope: 'session' })
    else if (action === 'permissionReason') openReason()
    else return
    ev.preventDefault()
    ev.stopPropagation()
  }

  function onReasonKeyDown(ev: React.KeyboardEvent<HTMLInputElement>): void {
    if (ev.nativeEvent.isComposing || ev.keyCode === 229) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      closeReason()
    } else if (ev.key === 'Enter' && !chorded(ev) && !ev.shiftKey) {
      ev.preventDefault()
      ev.stopPropagation()
      deny()
    }
  }

  return (
    <div
      ref={card}
      className="permission-card"
      data-testid="permission-card"
      data-card-focus=""
      tabIndex={-1}
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
      <div className="permission-card-head">
        <strong>{item.toolName}</strong>
        <span className="permission-card-target">{item.target}</span>
      </div>
      <div className="permission-card-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="permission-allow"
          title="Разрешить (1 или Enter)"
          onClick={() => answer({ behavior: 'allow', scope: 'once' })}
        >
          <Check size={14} aria-hidden="true" />
          Разрешить
          <kbd>1</kbd>
        </button>
        <button
          type="button"
          className="btn"
          data-testid="permission-allow-all"
          title="Разрешить всё такое (2)"
          onClick={() => answer({ behavior: 'allow', scope: 'always' })}
        >
          <CheckCheck size={14} aria-hidden="true" />
          Разрешить всё такое
          <kbd>2</kbd>
        </button>
        <button
          type="button"
          className="btn"
          data-testid="permission-allow-session"
          title="Разрешить такое до конца сессии этого чата (3)"
          onClick={() => answer({ behavior: 'allow', scope: 'session' })}
        >
          <Clock size={14} aria-hidden="true" />
          Разрешить до конца сессии
          <kbd>3</kbd>
        </button>
        <button
          type="button"
          className="btn btn-danger"
          data-testid="permission-deny"
          title="Запретить (4 или Esc)"
          aria-expanded={reasonOpen}
          onClick={openReason}
        >
          <X size={14} aria-hidden="true" />
          Запретить
          <kbd>4</kbd>
        </button>
      </div>
      {reasonOpen && (
        <div className="permission-card-reason">
          <input
            ref={field}
            type="text"
            className="field permission-card-reason-field"
            data-testid="permission-deny-reason"
            aria-label="Причина отказа"
            placeholder="Почему нет / что сделать вместо (необязательно)"
            maxLength={CARD_TEXT_MAX}
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            onKeyDown={onReasonKeyDown}
          />
          <TextCount length={reason.length} testId="permission-deny-count" />
          <button
            type="button"
            className="btn btn-danger"
            data-testid="permission-deny-send"
            title="Запретить (Enter)"
            onClick={deny}
          >
            <SendHorizontal size={14} aria-hidden="true" />
            Запретить
          </button>
        </div>
      )}
    </div>
  )
}
