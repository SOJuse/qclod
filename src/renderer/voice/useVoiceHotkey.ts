import { useEffect, useRef } from 'react'
import { useAppStore } from '../state/useAppStore'
import { isVoiceKey } from './holdToTalk'
import {
  blurVoice,
  hideVoice,
  pressVoice,
  releaseVoice,
  setVoiceHooks,
  startVoiceSync,
  stopVoice,
  useVoice,
  type VoiceHooks
} from './voiceStore'

/** A sheet or a dialog is open: voice keys are not ours there (decision 5). */
function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

/**
 * Ctrl+Space inside the window only (G10): held — talk while holding; pressed
 * once — start, again — stop. Its target is the active pane. Esc while
 * recording stops the voice, not the agent (decision 6). Losing the focus
 * stops a hold; hiding the window stops any recording.
 */
export function useVoiceHotkey(hooks: VoiceHooks): void {
  const hooksRef = useRef(hooks)
  hooksRef.current = hooks

  useEffect(() => {
    setVoiceHooks({
      openSettings: () => hooksRef.current.openSettings(),
      focusField: () => hooksRef.current.focusField()
    })
    const stopSync = startVoiceSync()
    /** The voice key is down: its release (of Space or of Ctrl) ends a hold. */
    let held = false

    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape' && useVoice.getState().session !== null && !modalOpen()) {
        // Before the field sees it: Esc there would interrupt the agent.
        ev.preventDefault()
        ev.stopPropagation()
        stopVoice()
        return
      }
      if (!isVoiceKey(ev)) return
      ev.preventDefault()
      if (ev.repeat || modalOpen()) return
      const tabId = useAppStore.getState().activeTabId
      if (!tabId) return
      held = true
      pressVoice(tabId, 'key')
    }
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (!held) return
      if (ev.code !== 'Space' && ev.key !== 'Control') return
      if (ev.code === 'Space') ev.preventDefault()
      held = false
      releaseVoice()
    }
    const onBlur = (): void => {
      held = false
      blurVoice()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        held = false
        hideVoice()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      stopSync()
    }
  }, [])
}
