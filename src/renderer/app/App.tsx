import { useCallback, useEffect } from 'react'
import { TerminalView } from '../components/TerminalView'
import { Composer } from '../components/Composer'
import { useAppStore } from '../state/useAppStore'
import './App.css'

export function App(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const focusTarget = useAppStore((s) => s.focusTarget)
  const setFocusTarget = useAppStore((s) => s.setFocusTarget)
  const toggleFocusTarget = useAppStore((s) => s.toggleFocusTarget)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const menuActive = useAppStore((s) => s.menuActiveByTab[s.activeTabId] ?? false)

  useEffect(() => {
    void window.qclod.getSettings().then(setSettings)
    return window.qclod.onSettingsChanged(setSettings)
  }, [setSettings])

  const setFontSize = useCallback(
    (fontSize: number) => {
      patchSettings({ fontSize })
      void window.qclod.setSettings({ fontSize })
    },
    [patchSettings]
  )

  const setMenuActive = useAppStore((s) => s.setMenuActive)
  const autoFocusOnMenu = settings?.autoFocusOnMenu ?? true

  const onMenuActive = useCallback(
    (active: boolean) => {
      setMenuActive(activeTabId, active)
      // Convenience only — the Ctrl+` toggle and the empty-field key rules
      // work regardless, and this can be switched off in settings (spec 6.4).
      if (active && autoFocusOnMenu) setFocusTarget('terminal')
    },
    [activeTabId, autoFocusOnMenu, setFocusTarget, setMenuActive]
  )

  return (
    <div className="app" data-testid="app-root">
      <header className="app-bar">
        <span className="app-name">Qclod</span>
      </header>
      {settings && (
        <>
          <TerminalView
            tabId={activeTabId}
            fontSize={settings.fontSize}
            focused={focusTarget === 'terminal'}
            onRequestFocus={() => setFocusTarget('terminal')}
            onToggleFocus={toggleFocusTarget}
            onFontSize={setFontSize}
            onMenuActive={onMenuActive}
          />
          <Composer
            tabId={activeTabId}
            focused={focusTarget === 'composer'}
            menuActive={menuActive}
            onRequestFocus={() => setFocusTarget('composer')}
            onToggleFocus={toggleFocusTarget}
          />
        </>
      )}
    </div>
  )
}
