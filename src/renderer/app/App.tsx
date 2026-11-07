import { useEffect } from 'react'
import { useAppStore } from '../state/useAppStore'
import './App.css'

/**
 * Skeleton while the v2 surfaces land: the ribbon (Task 8), the composer
 * (Task 10), the side panel (Task 12) and the history screen (Task 14) each
 * arrive with their own tests. Keeping this honest and small beats a mock that
 * looks finished.
 */
export function App(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)

  useEffect(() => {
    void window.qclod.getSettings().then(setSettings)
    return window.qclod.onSettingsChanged(setSettings)
  }, [setSettings])

  return (
    <div className="app" data-testid="app-root">
      <header className="app-bar">
        <span className="app-name">Qclod</span>
      </header>
      {settings && <div className="app-empty" data-testid="app-ready" />}
    </div>
  )
}
