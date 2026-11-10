import { useEffect, useRef } from 'react'
import { Check, CheckCheck, X } from 'lucide-react'
import type { RibbonItem } from '../../shared/types'
import { resolveComposerKey } from '../input/keyPrecedence'

type Permission = Extract<RibbonItem, { kind: 'permission' }>

interface Props {
  item: Permission
  /** The earliest question still waiting: the one that takes focus and the keys. */
  active?: boolean
  onAnswer: (requestId: string, behavior: 'allow' | 'deny', remember?: boolean) => void
}

/** Text typed into the input line is never taken from the person typing it. */
function composerHasDraft(): boolean {
  const el = document.activeElement
  return el instanceof HTMLTextAreaElement && el.dataset['testid'] === 'composer-input' && el.value !== ''
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
  const pending = item.state === 'pending'
  const takesFocus = pending && active

  useEffect(() => {
    if (!takesFocus) return
    // After the other effects of this commit: a tab switch hands focus to the
    // input line in one of them, and the card asks only after that.
    const timer = setTimeout(() => {
      const el = card.current
      if (!el || composerHasDraft()) return
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    }, 0)
    return () => clearTimeout(timer)
  }, [takesFocus, item.requestId])

  function answer(behavior: 'allow' | 'deny', remember?: boolean): void {
    // Focus goes back to the input line, so the next thing typed lands there
    // and not on a card that has been answered.
    const hadFocus = card.current?.contains(document.activeElement) ?? false
    const pane = card.current?.closest('[data-testid="chat-pane"]')
    onAnswer(item.requestId, behavior, remember)
    if (hadFocus) {
      pane?.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')?.focus()
    }
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLDivElement>): void {
    if (!takesFocus) return
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
        caretAtStart: true,
        caretAtEnd: true,
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
      onKeyDown={onKeyDown}
    >
      <div className="row-permission-head">
        <strong>{item.toolName}</strong>
        <span className="row-permission-target">{item.target}</span>
      </div>
      {pending ? (
        <div className="row-permission-actions">
          <button
            type="button"
            className="btn-primary"
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
            className="btn-danger"
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
          {item.state === 'allowed' ? 'разрешено' : 'отклонено'}
        </div>
      )}
    </div>
  )
}
