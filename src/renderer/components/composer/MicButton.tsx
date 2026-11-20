import { Mic } from 'lucide-react'
import type { VoiceControls } from './voice'

interface Props {
  /** Этап 5's own voice input; without it the button hands over to Windows dictation. */
  voice?: VoiceControls
  disabled: boolean
  /** Win+H: the composer puts the focus in the field first, Windows types into it. */
  onFallback(): void
}

const FALLBACK_TITLE = 'Голосовой ввод — диктовка Windows (Win+H). Говорите, текст появится в поле'

/**
 * The microphone beside the clip (сверка F1). It draws the button and its
 * states only: holding to talk or pressing once is told apart by этап 5, and
 * so are the menu of `download` and `unavailable`, the grey tentative text
 * and the caret after an insert.
 */
export function MicButton({ voice, disabled, onFallback }: Props): JSX.Element {
  if (!voice) {
    return (
      <button
        type="button"
        className="composer-mic"
        data-testid="composer-mic"
        aria-label="Голосовой ввод"
        title={FALLBACK_TITLE}
        disabled={disabled}
        onClick={() => onFallback()}
      >
        <Mic size={16} aria-hidden="true" />
      </button>
    )
  }
  const progress =
    voice.progress !== undefined && (voice.state === 'download' || voice.state === 'loading')
      ? Math.round(Math.min(1, Math.max(0, voice.progress)) * 100)
      : null
  return (
    <button
      type="button"
      className="composer-mic"
      data-testid="composer-mic"
      data-state={voice.state}
      aria-label={voice.title}
      aria-pressed={voice.state === 'listening'}
      title={voice.title}
      disabled={disabled}
      onPointerDown={(ev) => {
        // Only the main button talks; the field keeps the focus it has.
        if (ev.button !== 0) return
        ev.preventDefault()
        voice.press()
      }}
      onPointerUp={(ev) => {
        if (ev.button !== 0) return
        voice.release()
      }}
    >
      <Mic size={16} aria-hidden="true" />
      {progress !== null && (
        // A ring round the button: its track and its sweep take their colours from Composer.css.
        <svg
          className="composer-mic-progress"
          data-testid="composer-mic-progress"
          role="progressbar"
          aria-label={voice.title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          viewBox="0 0 28 28"
        >
          <circle className="composer-mic-track" cx="14" cy="14" r="12.5" pathLength={100} />
          <circle
            className="composer-mic-sweep"
            cx="14"
            cy="14"
            r="12.5"
            pathLength={100}
            strokeDasharray={`${progress} 100`}
          />
        </svg>
      )}
    </button>
  )
}
