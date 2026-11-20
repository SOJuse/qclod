import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, SendHorizontal } from 'lucide-react'
import type { CardAnswers } from '../../chat/cardAnswers'
import { createKeyGuard, heldKeys } from '../../chat/permissionKeyGuard'
import {
  canAdvance,
  collect,
  displayLabel,
  goTo,
  initialSteps,
  pick,
  setText
} from '../../chat/questionSteps'
import { physicalKey } from '../../input/physicalKey'
import { resolveComposerKey } from '../../input/keyPrecedence'
import { CARD_TEXT_MAX, TextCount } from './TextLimit'
import type { QuestionItem } from './types'
import './QuestionCard.css'

interface Props {
  item: QuestionItem
  answers: CardAnswers
  /** The card in front of the strip: its keys answer it. */
  focused: boolean
}

/** Options past the ninth have no digit. */
const DIGITS = 9

/** Held, auto-repeating or chorded keys never answer. */
function chorded(ev: React.KeyboardEvent): boolean {
  return ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey
}

/** What the field under the options is for right now. */
function placeholderFor(picked: string[]): string {
  if (picked.length === 0) return 'Свой ответ…'
  if (picked.length === 1) return `Комментарий к «${displayLabel(picked[0]!).text}» (необязательно)`
  return 'Комментарий (необязательно)'
}

/**
 * The agent asked something with options — one to four questions, shown one
 * at a time (spec C7), all sent together after the last.
 *
 * On the card itself 1–9 choose (a multi-choice question toggles) and Enter
 * goes on — or sends, on the last question. A click on an option only chooses
 * it (П17): the comment is written after, and «Дальше», «Ответить» or Enter
 * moves on. The field under the options is always there (C1): with nothing
 * chosen it is the answer, with something chosen a comment on it. In the field
 * digits are text, Enter goes on, Shift+Enter breaks the line and Esc goes
 * back to the card. The card's keys never work from the input line: it has
 * them only while it has focus itself, armed as the permission card is.
 */
export function QuestionCard({ item, answers, focused }: Props): JSX.Element {
  const questions = item.questions
  const card = useRef<HTMLDivElement | null>(null)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const guard = useRef(createKeyGuard())
  /** A Space key-down was refused, so its key-up must not click the button. */
  const spaceRefused = useRef(false)
  /** Answers go once: a second Enter before the card closes sends nothing. */
  const sent = useRef(false)
  /** A step changed under focus on a button that is now gone: focus goes to the card. */
  const refocus = useRef(false)
  const [state, setState] = useState(() => initialSteps(questions))
  useEffect(() => {
    const own = guard.current
    return () => own.dispose()
  }, [])
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    card.current?.focus({ preventScroll: true })
  }, [state.step])

  const q = questions[state.step]
  const last = state.step >= questions.length - 1
  const ready = questions.length === 0 || canAdvance(state)
  const picked = state.picks[state.step] ?? []
  const text = state.texts[state.step] ?? ''

  function choose(label: string): void {
    if (!q) return
    setState((s) => pick(s, q, label))
  }

  function step(to: number): void {
    const el = document.activeElement
    refocus.current = !!card.current?.contains(el) && el !== field.current
    setState((s) => goTo(s, to))
  }

  function submit(): void {
    if (sent.current) return
    sent.current = true
    // Focus goes back to the input line, so the next thing typed lands there
    // and not on a card that has been answered.
    const hadFocus = card.current?.contains(document.activeElement) ?? false
    const pane = card.current?.closest('[data-testid="chat-pane"]')
    const given = collect(questions, state)
    answers.question(item.toolUseId, given.answers, given.notes)
    if (hadFocus) pane?.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus()
  }

  function next(): void {
    if (sent.current || !ready) return
    if (last) submit()
    else step(state.step + 1)
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLDivElement>): void {
    // The field keeps its keys: a digit there is text.
    if (ev.target === field.current) return
    const target = ev.target
    if (target instanceof HTMLButtonElement && (ev.key === 'Enter' || ev.key === ' ')) {
      // A button would click itself on Enter and Space: held, repeating,
      // chorded or too-early presses are stopped before it can.
      const refused = chorded(ev) || !guard.current.allows(ev.code || ev.key, performance.now())
      if (refused) {
        ev.preventDefault()
        ev.stopPropagation()
        if (ev.key === ' ') spaceRefused.current = true
        return
      }
      if (ev.key === ' ') spaceRefused.current = false
      // Enter on an option goes on, as on the card; anything else is the button's own click.
      if (ev.key === ' ' || !target.hasAttribute('data-question-option')) return
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
        pendingQuestion: true
      }
    )
    if (action === 'questionPick') {
      const option = q?.options[Number(physicalKey(ev)) - 1]
      if (!option) return
      choose(option.label)
    } else if (action === 'questionNext') {
      next()
    } else {
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
  }

  function onFieldKeyDown(ev: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (ev.nativeEvent.isComposing || ev.keyCode === 229) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      card.current?.focus({ preventScroll: true })
    } else if (ev.key === 'Enter' && !ev.shiftKey && !chorded(ev)) {
      ev.preventDefault()
      ev.stopPropagation()
      next()
    }
  }

  return (
    <div
      ref={card}
      className="question-card"
      data-testid="question-card"
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
      {questions.length > 1 && (
        <div className="question-card-progress" data-testid="question-progress">
          Вопрос {state.step + 1} из {questions.length}
        </div>
      )}
      {q && (
        <>
          <div className="question-card-head">
            {q.header && <span className="question-card-chip">{q.header}</span>}
            <span className="question-card-text">{q.question}</span>
          </div>
          {q.multiSelect && <div className="question-card-hint">можно несколько</div>}
          <div className="question-card-options">
            {q.options.map((option, i) => {
              const chosen = picked.includes(option.label)
              const shown = displayLabel(option.label)
              const digit = i < DIGITS ? i + 1 : null
              return (
                <button
                  key={`${state.step}:${option.label}`}
                  type="button"
                  className={chosen ? 'question-card-option is-chosen' : 'question-card-option'}
                  data-testid="question-option"
                  data-question-option=""
                  aria-pressed={chosen}
                  title={digit === null ? shown.text : `${shown.text} (${digit})`}
                  onClick={() => choose(option.label)}
                >
                  <span className="question-card-num" aria-hidden="true">
                    {digit === null ? '' : `${digit}.`}
                  </span>
                  <span className="question-card-body">
                    <span className="question-card-label">
                      {shown.text}
                      {shown.recommended && <span className="question-card-badge">рекомендуется</span>}
                      {chosen && <Check size={13} aria-hidden="true" className="question-card-check" />}
                    </span>
                    {option.description && <span className="question-card-desc">{option.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="question-card-own">
            <textarea
              ref={field}
              rows={1}
              className="field question-card-own-field"
              data-testid="question-own"
              aria-label={placeholderFor(picked)}
              placeholder={placeholderFor(picked)}
              maxLength={CARD_TEXT_MAX}
              value={text}
              onChange={(ev) => {
                const value = ev.target.value
                setState((s) => setText(s, value))
              }}
              onKeyDown={onFieldKeyDown}
            />
            <TextCount length={text.length} testId="question-own-count" />
          </div>
        </>
      )}
      <div className="question-card-actions">
        {state.step > 0 && (
          <button
            type="button"
            className="btn"
            data-testid="question-back"
            title="Предыдущий вопрос"
            onClick={() => step(state.step - 1)}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Назад
          </button>
        )}
        {last ? (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="question-submit"
            title="Отправить ответы агенту (Enter)"
            disabled={!ready}
            onClick={next}
          >
            <SendHorizontal size={14} aria-hidden="true" />
            Ответить
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="question-next"
            title="Следующий вопрос (Enter)"
            disabled={!ready}
            onClick={next}
          >
            Дальше
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
