import { useRef, type ReactNode, type SyntheticEvent } from 'react'

interface Props {
  /** A countdown runs for this card. */
  active: boolean
  onStop(): void
  children: ReactNode
}

/**
 * Wraps the pinned card while «авто-да» counts down on it: the person
 * starting to answer — a click, a key, typing — stops the timer, once, so
 * Qclod never answers over them (decision 3). Events are watched in the
 * capture phase, before the card itself acts on them. The countdown's own
 * strip is left alone: «Ответить сейчас» must reach a timer still running.
 */
export function AutoAnswerGuard({ active, onStop, children }: Props): JSX.Element {
  const stopped = useRef(false)
  const touch = (e: SyntheticEvent): void => {
    if (!active || stopped.current) return
    if (e.target instanceof Element && e.target.closest('[data-testid="auto-answer"]')) return
    stopped.current = true
    onStop()
  }
  return (
    <div
      className="auto-answer-guard"
      data-testid="auto-answer-guard"
      onPointerDownCapture={touch}
      onKeyDownCapture={touch}
      onInputCapture={touch}
    >
      {children}
    </div>
  )
}
