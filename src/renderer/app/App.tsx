import { useCallback, useEffect, useState } from 'react'
import type { HotkeyRegistration } from '../../shared/types'
import { useAppStore } from '../state/useAppStore'
import { TitleBar } from '../components/TitleBar'
import { Ribbon } from '../components/Ribbon'
import { SettingsScreen } from '../components/SettingsScreen'
import './App.css'

/**
 * The window: tabs across the top, the conversation below.
 *
 * The composer (Task 10), the command palette (Task 11) and the side panel
 * (Task 12) land next; each arrives with its own tests rather than as a mock
 * that looks finished.
 */
export function App(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [hotkey, setHotkey] = useState<HotkeyRegistration | null>(null)
  const settings = useAppStore((s) => s.settings)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const ribbonByTab = useAppStore((s) => s.ribbonByTab)
  const todoByTab = useAppStore((s) => s.todoByTab)

  const setSettings = useAppStore((s) => s.setSettings)
  const setTabs = useAppStore((s) => s.setTabs)
  const setActiveTabId = useAppStore((s) => s.setActiveTabId)
  const setRibbon = useAppStore((s) => s.setRibbon)
  const applyRibbon = useAppStore((s) => s.applyRibbon)
  const applyPanel = useAppStore((s) => s.applyPanel)

  useEffect(() => {
    void window.qclod.getSettings().then(setSettings)
    void window.qclod.listTabs().then(setTabs)
    void window.qclod.appVersion().then(setVersion)
    void window.qclod.hotkeyStatus().then(setHotkey)

    const unsubscribers = [
      window.qclod.onSettingsChanged(setSettings),
      window.qclod.onTabsChanged(setTabs),
      window.qclod.onActivateTab((id) => setActiveTabId(id)),
      window.qclod.onRibbon((event) => applyRibbon(event.tabId, event.changes)),
      window.qclod.onPanel((event) => applyPanel(event.tabId, event.patch))
    ]
    return () => {
      for (const off of unsubscribers) off()
    }
  }, [setSettings, setTabs, setActiveTabId, applyRibbon, applyPanel])

  // The first tab the main process reports is the one to show.
  useEffect(() => {
    if (!activeTabId && tabs.length > 0) setActiveTabId(tabs[0]!.id)
  }, [tabs, activeTabId, setActiveTabId])

  const activate = useCallback(
    (id: string) => {
      setActiveTabId(id)
      void window.qclod.activateTab(id)
      // A tab being switched to draws itself from what it already has, rather
      // than replaying the session.
      void window.qclod.ribbon(id).then((items) => setRibbon(id, items))
    },
    [setActiveTabId, setRibbon]
  )

  const answerPermission = useCallback(
    (requestId: string, behavior: 'allow' | 'deny', remember?: boolean) => {
      void window.qclod.answerPermission(requestId, {
        behavior,
        ...(remember ? { remember: true } : {})
      })
    },
    []
  )

  const answerQuestion = useCallback(
    (toolUseId: string, choice: string) => {
      if (activeTabId) void window.qclod.answerQuestion(activeTabId, toolUseId, choice)
    },
    [activeTabId]
  )

  return (
    <div className="app" data-testid="app-root">
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={activate}
        onClose={(id) => void window.qclod.closeTab(id)}
        onCreate={() => {
          void window.qclod.pickFolder().then((cwd) => {
            if (cwd) void window.qclod.createTab(cwd)
          })
        }}
        onConfigure={() => setSettingsOpen(true)}
        hotkey={hotkey}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settings && <div className="app-ready" data-testid="app-ready" hidden />}
      <Ribbon
        items={ribbonByTab[activeTabId] ?? []}
        todo={todoByTab[activeTabId] ?? []}
        onAnswerPermission={answerPermission}
        onAnswerQuestion={answerQuestion}
      />
      {settingsOpen && settings && (
        <SettingsScreen
          settings={settings}
          version={version}
          onPatch={(patch) => {
            void window.qclod.setSettings(patch).then(setSettings)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
