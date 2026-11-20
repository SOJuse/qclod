import { useEffect, useRef, useState } from 'react'
import { Check, Pencil, SendHorizontal, Undo2, X } from 'lucide-react'
import type { PlanDecision } from '../../../shared/types'
import type { CardAnswers } from '../../chat/cardAnswers'
import { chorded } from '../../chat/keyChords'
import { createKeyGuard, heldKeys } from '../../chat/permissionKeyGuard'
import { resolveComposerKey } from '../../input/keyPrecedence'
import { Markdown } from '../../markdown/Markdown'
import { PLAN_COMMENT_MAX, PLAN_TEXT_MAX, TextCount } from './TextLimit'
import type { PlanItem } from './types'
import './PlanCard.css'

interface Props {
  item: PlanItem
  answers: CardAnswers
  /** The card in front of the strip: its keys answer it. */
  focused?: boolean
  /** Paths in the plan become links for this tab. */
  tabId?: string
}

/** What the card is showing: the plan with its buttons, a refusal being written, or the plan being edited. */
type Mode = 'plan' | 'reject' | 'edit'

function composing(ev: React.KeyboardEvent): boolean {
  return ev.nativeEvent.isComposing || ev.keyCode === 229
}

/**
 * What the agent intends to do, before it does any of it (spec 6.4).
 *
 * On the card 1 (and Enter) approves, 2 rejects — the comment field opens
 * first, and its Enter sends the refusal, empty or not — and 3 opens the plan
 * for editing: Ctrl+Enter approves it as edited, Esc goes back to the
 * buttons. An edit that is empty or changes nothing approves nothing. The keys
 * work only while the card itself — its root, not a link or the plan text
 * inside it — has focus, armed as the permission card is; in the comment
 * field and the editor digits are text. While a refusal is
 * being written the digits answer nothing and Enter on any of the card's
 * buttons sends the refusal (S2-R15, as on the permission card).
 *
 * The window sends the decision and the texts only; main turns them into
 * ExitPlanMode's answer, by what the CLI is known to carry out (S2-R8).
 */
export function PlanCard({ item, answers, focused = true, tabId }: Props): JSX.Element {
  const card = useRef<HTMLDivElement | null>(null)
  const commentField = useRef<HTMLTextAreaElement | null>(null)
  const editor = useRef<HTMLTextAreaElement | null>(null)
  const guard = useRef(createKeyGuard())
  /** A Space key-down was refused, so its key-up must not click the button. */
  const spaceRefused = useRef(false)
  /** The key that opened the comment field or the editor, until it is let go. */
  const openedBy = useRef<string | null>(null)
  /** The decision goes once: a second Enter before the card closes sends nothing. */
  const sent = useRef(false)
  /** Focus was in the part that went away: it comes back to the card. */
  const refocus = useRef(false)
  const [mode, setMode] = useState<Mode>('plan')
  const [comment, setComment] = useState('')
  const [draft, setDraft] = useState(item.text)
  useEffect(() => {
    const own = guard.current
    return () => own.dispose()
  }, [])
  useEffect(() => {
    if (mode === 'reject') commentField.current?.focus()
    else if (mode === 'edit') editor.current?.focus()
    else if (refocus.current) card.current?.focus({ preventScroll: true })
    refocus.current = false
  }, [mode])

  const editable = draft.trim() !== '' && draft !== item.text && draft.length <= PLAN_TEXT_MAX

  function decide(decision: PlanDecision): void {
    if (sent.current) return
    sent.current = true
    // Focus goes back to the input line, so the next thing typed lands there
    // and not on a card that has been answered.
    const hadFocus = card.current?.contains(document.activeElement) ?? false
    const pane = card.current?.closest('[data-testid="chat-pane"]')
    answers.plan(item.requestId, decision)
    if (hadFocus) pane?.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus()
  }

  function reject(): void {
    const why = comment.trim()
    decide(why ? { approve: false, comment: why } : { approve: false })
  }

  function approveEdited(): void {
    if (editable) decide({ approve: true, plan: draft })
  }

  function openReject(): void {
    if (mode === 'reject') commentField.current?.focus()
    else setMode('reject')
  }

  function openEdit(): void {
    if (mode === 'edit') {
      editor.current?.focus()
      return
    }
    setDraft(item.text)
    setMode('edit')
  }

  /** Back to the plan and its buttons; an edit in progress is dropped. */
  function back(): void {
    refocus.current = true
    setMode('plan')
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLDivElement>): void {
    // The fields keep their keys: a digit there is text.
    if (ev.target === commentField.current || ev.target === editor.current) return
    // A button would click itself on Enter and Space: held, repeating, chorded
    // or too-early presses are stopped before it can.
    if (ev.target instanceof HTMLButtonElement && (ev.key === 'Enter' || ev.key === ' ')) {
      const refused = chorded(ev) || !guard.current.allows(ev.code || ev.key, performance.now())
      if (refused) {
        ev.preventDefault()
        ev.stopPropagation()
        if (ev.key === ' ') spaceRefused.current = true
        return
      }
      if (ev.key === ' ') spaceRefused.current = false
      if (mode !== 'reject') return
      // A refusal is being written: Enter or Space on any of the card's
      // buttons sends it, never the button's own approval.
      ev.preventDefault()
      ev.stopPropagation()
      if (ev.key === ' ') spaceRefused.current = true
      reject()
      return
    }
    if (!focused) return
    // Only the card itself answers to keys. A link in the plan, the plan text
    // (focusable to scroll it) and the buttons' digits are not the card: Enter
    // on a link opens the link and approves nothing. Esc below only moves
    // between the card's parts, so it is taken from anywhere in it.
    const onCard = ev.target === card.current
    if (!onCard && ev.key !== 'Escape') return
    // Keys still in flight when the card appeared never answer: only a fresh
    // plain press after it is armed.
    if (chorded(ev) || !guard.current.allows(ev.code || ev.key, performance.now())) return
    if (mode !== 'plan') {
      // A refusal or an edit under way: the digits answer nothing. Enter sends
      // the refusal; Esc goes back to the comment, or out of the edit.
      if (composing(ev)) return
      if (mode === 'reject' && ev.key === 'Enter' && !ev.shiftKey) reject()
      else if (mode === 'reject' && ev.key === 'Escape') openReject()
      else if (mode === 'edit' && ev.key === 'Escape') back()
      else return
      ev.preventDefault()
      ev.stopPropagation()
      return
    }
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
        pendingPlan: true
      }
    )
    if (action === 'planApprove') decide({ approve: true })
    else if (action === 'planReject' || action === 'planEdit') {
      openedBy.current = ev.code || ev.key
      if (action === 'planReject') openReject()
      else openEdit()
    } else return
    ev.preventDefault()
    ev.stopPropagation()
  }

  /** The held key that opened a field: its auto-repeat is not text. */
  function heldOpener(ev: React.KeyboardEvent): boolean {
    if (!ev.repeat || openedBy.current === null || (ev.code || ev.key) !== openedBy.current) return false
    ev.preventDefault()
    ev.stopPropagation()
    return true
  }

  function onCommentKeyDown(ev: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (composing(ev) || heldOpener(ev)) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      back()
    } else if (ev.key === 'Enter' && !ev.shiftKey && !chorded(ev)) {
      ev.preventDefault()
      ev.stopPropagation()
      reject()
    }
  }

  function onEditorKeyDown(ev: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (composing(ev) || heldOpener(ev)) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      back()
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && !ev.repeat) {
      ev.preventDefault()
      ev.stopPropagation()
      approveEdited()
    }
  }

  return (
    <div
      ref={card}
      className="plan-card"
      data-testid="plan-card"
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
        if ((ev.code || ev.key) === openedBy.current) openedBy.current = null
        if (ev.key !== ' ' || !spaceRefused.current) return
        spaceRefused.current = false
        ev.preventDefault()
      }}
    >
      {mode === 'edit' ? (
        <>
          <textarea
            ref={editor}
            className="field plan-card-editor"
            data-testid="plan-editor"
            aria-label="Текст плана"
            spellCheck={false}
            maxLength={PLAN_TEXT_MAX}
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={onEditorKeyDown}
          />
          <div className="plan-card-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="plan-approve-edited"
              title="Одобрить план с правками (Ctrl+Enter)"
              disabled={!editable}
              onClick={approveEdited}
            >
              <Check size={14} aria-hidden="true" />
              Одобрить с правками
            </button>
            <button
              type="button"
              className="btn"
              data-testid="plan-edit-cancel"
              title="Вернуться к плану без правок (Esc)"
              onClick={back}
            >
              <Undo2 size={14} aria-hidden="true" />
              Отмена
            </button>
            <TextCount length={draft.length} max={PLAN_TEXT_MAX} testId="plan-editor-count" />
          </div>
        </>
      ) : (
        <>
          <div className="plan-card-text" data-testid="plan-text" tabIndex={0} aria-label="Текст плана">
            <Markdown text={item.text} {...(tabId ? { tabId } : {})} />
          </div>
          <div className="plan-card-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="plan-approve"
              title="Одобрить план и выполнять его (1 или Enter)"
              onClick={() => decide({ approve: true })}
            >
              <Check size={14} aria-hidden="true" />
              Одобрить
              <kbd>1</kbd>
            </button>
            <button
              type="button"
              className="btn btn-danger"
              data-testid="plan-reject"
              title="Отклонить план, сказав, что изменить (2)"
              aria-expanded={mode === 'reject'}
              onClick={openReject}
            >
              <X size={14} aria-hidden="true" />
              Отклонить
              <kbd>2</kbd>
            </button>
            <button
              type="button"
              className="btn"
              data-testid="plan-edit"
              title="Поправить текст плана перед одобрением (3)"
              onClick={openEdit}
            >
              <Pencil size={14} aria-hidden="true" />
              Править
              <kbd>3</kbd>
            </button>
          </div>
          {mode === 'reject' && (
            <div className="plan-card-comment">
              <textarea
                ref={commentField}
                rows={1}
                className="field plan-card-comment-field"
                data-testid="plan-comment"
                aria-label="Что изменить в плане"
                placeholder="Что изменить в плане? (необязательно)"
                maxLength={PLAN_COMMENT_MAX}
                value={comment}
                onChange={(ev) => setComment(ev.target.value)}
                onKeyDown={onCommentKeyDown}
              />
              <TextCount length={comment.length} max={PLAN_COMMENT_MAX} testId="plan-comment-count" />
              <button
                type="button"
                className="btn btn-danger"
                data-testid="plan-reject-send"
                title="Отклонить план (Enter)"
                onClick={reject}
              >
                <SendHorizontal size={14} aria-hidden="true" />
                Отклонить
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
