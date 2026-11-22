import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Timer } from 'lucide-react'
import {
  arrivalOf,
  claimFocusOffer,
  focusedLongEnough,
  trackHeldKeys,
  windowFocusedSince
} from '../../chat/permissionKeyGuard'
import type { AutoAnswerView, OpenCard } from './types'
import './PinnedCard.css'

trackHeldKeys()

/** «4:59», «0:05»; nothing left, or less, is «0:00». */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000))
  const seconds = total % 60
  return `${Math.floor(total / 60)}:${seconds < 10 ? '0' : ''}${seconds}`
}

/**
 * Whether a card may take focus. Only when the window has been in front for a
 * while before the card came, the pane is the one being worked in, no dialog,
 * sheet or palette is open, and focus rests on nothing, on this pane's empty
 * input line, inside this pane's ribbon or inside its pinned strip. Anything
 * else — another pane, a settings control, a draft — is where the person is,
 * and the card just shows.
 */
function mayTakeFocus(card: HTMLElement, arrivedAt: number): boolean {
  if (!document.hasFocus() || !focusedLongEnough(windowFocusedSince(), arrivedAt)) return false
  const pane = card.closest('[data-testid="chat-pane"]')
  if (!pane?.classList.contains('is-focused')) return false
  // A dialog inside another pane (its agents layer, say) is that pane's
  // business; one in this pane or over the whole window holds the card back.
  const blocking = [
    ...document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [data-testid="settings"], [data-testid="action-palette"]'
    )
  ].some((d) => {
    const owner = d.closest('[data-testid="chat-pane"]')
    return owner === null || owner === pane
  })
  if (blocking) return false
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || el === document.body) return true
  if (el instanceof HTMLTextAreaElement && el.hasAttribute('data-composer-input')) {
    return pane.contains(el) && el.value === ''
  }
  return !!el.closest('[data-testid="ribbon"], [data-testid="pinned-cards"]') && pane.contains(el)
}

/** «Авто-да» is about to answer: what it will say, how soon, and the two ways to step in. */
function AutoAnswerStrip({ view }: { view: AutoAnswerView }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="pinned-auto" data-testid="auto-answer">
      <Timer size={13} aria-hidden="true" />
      <span className="pinned-auto-text">
        {view.label} через {formatCountdown(view.deadline - now)}
      </span>
      <button type="button" className="btn btn-sm" data-testid="auto-answer-now" onClick={view.onAnswerNow}>
        Ответить сейчас
      </button>
      <button type="button" className="btn btn-sm" data-testid="auto-answer-stop" onClick={view.onStop}>
        Остановить таймер
      </button>
    </div>
  )
}

interface Props {
  kind: OpenCard['kind']
  /** «Разрешение», «Вопрос», «План». */
  title: string
  /** A subagent's card: the agent's kind. */
  from?: string
  /** Set while «авто-да» is about to answer this card (stage 3); no timer logic lives here. */
  autoAnswer?: AutoAnswerView
  /** `cardIdOf(card)`: focus is offered once per card, not per mount. */
  cardId: string
  children: ReactNode
}

/**
 * The frame of a card pinned above the input: what kind it is, whose, and the
 * card's own body. When the card appears it takes focus — on its
 * `[data-card-focus]` element, where the body's keys live — but only if the
 * person is not somewhere else: an input line with text in it keeps focus.
 */
export function PinnedCard({ kind, title, from, autoAnswer, cardId, children }: Props): JSX.Element {
  const frame = useRef<HTMLElement | null>(null)
  /** When the card came — first shown, not this mount; the window must have been in front before that. */
  const arrivedAt = arrivalOf(cardId, performance.now())

  useEffect(() => {
    // After the other effects of this commit: a tab switch hands focus to the
    // input line in one of them, and the card asks only after that.
    const timer = setTimeout(() => {
      const el = frame.current
      // Offered once per card: a remount (tab shown again) must not pull
      // focus from wherever the person has gone since.
      if (!el || !claimFocusOffer(cardId)) return
      if (!mayTakeFocus(el, arrivedAt)) return
      el.querySelector<HTMLElement>('[data-card-focus]')?.focus({ preventScroll: true })
    }, 0)
    return () => clearTimeout(timer)
  }, [cardId, arrivedAt])

  return (
    <section ref={frame} className="pinned-card" data-testid="pinned-card" data-kind={kind} aria-label={title}>
      <header className="pinned-card-title">
        {title}
        {from !== undefined && <span className="pinned-card-from"> · от агента {from}</span>}
      </header>
      {autoAnswer && <AutoAnswerStrip view={autoAnswer} />}
      {children}
    </section>
  )
}
