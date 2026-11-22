import { useEffect, useRef, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react'
import { passingKey } from '../../chat/keyChords'
import { createKeyGuard, heldKeys, type KeyGuard } from '../../chat/permissionKeyGuard'

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
 *
 * Not every key is an answer: the card holds focus while it waits, so window
 * and tab switching, Tab to the strip's buttons, function keys, auto-repeat,
 * keys already down when the card came and keys in its first moments pass —
 * and so does the text such a held or early key types.
 */
export function AutoAnswerGuard({ active, onStop, children }: Props): JSX.Element {
  const stopped = useRef(false)
  const keys = useRef<KeyGuard | null>(null)
  if (keys.current === null) {
    keys.current = createKeyGuard()
    keys.current.focus(performance.now(), heldKeys())
  }
  useEffect(() => () => keys.current?.dispose(), [])
  /** The last key-down was held, repeating or too early: its input is not an answer. */
  const quiet = useRef(false)
  const touch = (e: SyntheticEvent): void => {
    if (!active || stopped.current) return
    if (e.target instanceof Element && e.target.closest('[data-testid="auto-answer"]')) return
    stopped.current = true
    onStop()
  }
  const keyDown = (e: KeyboardEvent): void => {
    quiet.current = e.repeat || !keys.current!.allows(e.code || e.key, performance.now())
    if (quiet.current || passingKey(e)) return
    touch(e)
  }
  const input = (e: SyntheticEvent): void => {
    if (quiet.current) return
    touch(e)
  }
  return (
    <div
      className="auto-answer-guard"
      data-testid="auto-answer-guard"
      onPointerDownCapture={touch}
      onKeyDownCapture={keyDown}
      onKeyUpCapture={(e) => keys.current!.released(e.code || e.key)}
      onInputCapture={input}
    >
      {children}
    </div>
  )
}
