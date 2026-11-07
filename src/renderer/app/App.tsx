import { useCallback, useEffect, useState } from 'react'
import { TerminalView } from '../components/TerminalView'
import type { AppSettings } from '../../shared/types'
import './App.css'

const IMPLICIT_TAB_ID = 'default'

export function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [focusTarget, setFocusTarget] = useState<'composer' | 'terminal'>('terminal')

  useEffect(() => {
    void window.qclod.getSettings().then(setSettings)
    return window.qclod.onSettingsChanged(setSettings)
  }, [])

  const setFontSize = useCallback((fontSize: number) => {
    setSettings((current) => (current ? { ...current, fontSize } : current))
    void window.qclod.setSettings({ fontSize })
  }, [])

  const toggleFocus = useCallback(() => {
    setFocusTarget((current) => (current === 'terminal' ? 'composer' : 'terminal'))
  }, [])

  return (
    <div className="app" data-testid="app-root">
      <header className="app-bar">
        <span className="app-name">Qclod</span>
      </header>
      {settings && (
        <TerminalView
          tabId={IMPLICIT_TAB_ID}
          fontSize={settings.fontSize}
          focused={focusTarget === 'terminal'}
          onRequestFocus={() => setFocusTarget('terminal')}
          onToggleFocus={toggleFocus}
          onFontSize={setFontSize}
        />
      )}
    </div>
  )
}
