import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { VoiceControls } from './voice'

/**
 * The grey line of the phrase being said (decision 4): a line of its own
 * inside the input's frame, never in the textarea, so typing is never fought.
 * Listening with nothing heard yet — «Слушаю…».
 */
export function VoiceTentative({ voice }: { voice?: VoiceControls | undefined }): JSX.Element | null {
  if (!voice) return null
  const text = voice.tentative !== '' ? voice.tentative : voice.state === 'listening' ? 'Слушаю…' : ''
  if (text === '') return null
  return (
    <div className="composer-voice-tentative" data-testid="composer-voice-tentative" aria-live="polite">
      {text}
    </div>
  )
}

/**
 * The microphone's menu, opened by its press in `download` and `unavailable`.
 * A pick closes it and gives the field the focus back first: Win+H types into
 * whatever has it.
 */
export function VoiceMenu({
  voice,
  field
}: {
  voice?: VoiceControls | undefined
  field: RefObject<HTMLTextAreaElement | null>
}): JSX.Element | null {
  const box = useRef<HTMLDivElement | null>(null)
  const open = voice?.menuOpen === true && voice.menu.length > 0
  const close = voice?.closeMenu

  useEffect(() => {
    if (!open || !close) return
    const onDown = (ev: PointerEvent): void => {
      const target = ev.target as Element | null
      // The microphone itself toggles the menu with its own press.
      if (box.current?.contains(target) || target?.closest?.('[data-testid="composer-mic"]')) return
      close()
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      close()
      field.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, close, field])

  if (!open || !voice) return null
  return (
    <div className="voice-menu" data-testid="voice-menu" role="menu" aria-label={voice.title} ref={box}>
      {voice.menu.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="voice-menu-item"
          data-testid={`voice-menu-${item.id}`}
          onClick={() => {
            voice.closeMenu?.()
            field.current?.focus()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/**
 * After a phrase went in, the caret stands after it (`caretAfterInsert`, a
 * new `rev` each time). A rev already there when the field mounted is old news.
 */
export function useVoiceCaret(
  voice: VoiceControls | undefined,
  field: RefObject<HTMLTextAreaElement | null>,
  onPlaced?: (at: number) => void
): void {
  const insert = voice?.caretAfterInsert
  const seen = useRef(insert?.rev ?? 0)
  const placed = useRef(onPlaced)
  placed.current = onPlaced
  useLayoutEffect(() => {
    if (!insert || insert.rev === seen.current) return
    seen.current = insert.rev
    const el = field.current
    if (!el) return
    const at = Math.min(insert.at, el.value.length)
    el.setSelectionRange(at, at)
    placed.current?.(at)
  }, [insert?.rev, insert?.at, field])
}
