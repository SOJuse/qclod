import { useCallback, useEffect, useRef, useState } from 'react'
import { TerminalView } from '../components/TerminalView'
import { Composer, type ComposerHandle } from '../components/Composer'
import { TitleBar } from '../components/TitleBar'
import { SettingsScreen } from '../components/SettingsScreen'
import { TabSettingsDialog } from '../components/TabSettingsDialog'
import { TabErrorPanel } from '../components/TabErrorPanel'
import { useAppStore } from '../state/useAppStore'
import { shouldStealFocus } from '../input/focusSteal'
import { useTabShortcuts } from './useTabShortcuts'
import type { HotkeyRegistration, TabId } from '../../shared/types'
import './App.css'

export function App(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const focusTarget = useAppStore((s) => s.focusTarget)
  const setFocusTarget = useAppStore((s) => s.setFocusTarget)
  const toggleFocusTarget = useAppStore((s) => s.toggleFocusTarget)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const setActiveTabId = useAppStore((s) => s.setActiveTabId)
  const tabs = useAppStore((s) => s.tabs)
  const setTabs = useAppStore((s) => s.setTabs)
  const setMenuActive = useAppStore((s) => s.setMenuActive)
  const menuActive = useAppStore((s) => s.menuActiveByTab[s.activeTabId] ?? false)
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const sessionDown = activeTab?.status === 'error' || activeTab?.status === 'exited'
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [configuringTab, setConfiguringTab] = useState<TabId | null>(null)
  const [version, setVersion] = useState('')
  const composerRef = useRef<ComposerHandle | null>(null)
  const [hotkey, setHotkey] = useState<HotkeyRegistration | null>(null)

  useEffect(() => {
    void window.qclod.getSettings().then(setSettings)
    return window.qclod.onSettingsChanged(setSettings)
  }, [setSettings])

  useEffect(() => {
    void window.qclod.listTabs().then(setTabs)
    return window.qclod.onTabsChanged(setTabs)
  }, [setTabs])

  useEffect(() => {
    void window.qclod.appVersion().then(setVersion)
  }, [])

  // A combination another app already holds has to be visible without opening
  // Settings — otherwise the user just concludes the hotkey does not work.
  useEffect(() => {
    void window.qclod.hotkeyStatus().then(setHotkey)
  }, [settings?.globalHotkey])

  const patchGlobalSettings = useCallback(
    (patch: Partial<typeof settings>) => {
      if (!patch) return
      patchSettings(patch as never)
      void window.qclod.setSettings(patch as never)
    },
    [patchSettings]
  )

  const setFontSize = useCallback(
    (fontSize: number) => {
      patchSettings({ fontSize })
      void window.qclod.setSettings({ fontSize })
    },
    [patchSettings]
  )

  const autoFocusOnMenu = settings?.autoFocusOnMenu ?? true

  const onMenuActive = useCallback(
    ({ focusWorthy, likely }: { focusWorthy: boolean; likely: boolean }) => {
      // The loose signal only decides where arrow keys go; the strict one is
      // the only thing allowed to move the keyboard.
      setMenuActive(activeTabId, likely)
      if (!focusWorthy) return
      const { draftByTab, lastTypedAt } = useAppStore.getState()
      // Terminal output is attacker-influenceable, so the keyboard only moves
      // when the person is clearly not mid-sentence. See focusSteal.ts.
      const allowed = shouldStealFocus({
        autoFocusOnMenu,
        draft: draftByTab[activeTabId] ?? '',
        msSinceTyping: Date.now() - lastTypedAt
      })
      if (allowed) setFocusTarget('terminal')
    },
    [activeTabId, autoFocusOnMenu, setFocusTarget, setMenuActive]
  )

  const createTab = useCallback(async () => {
    const cwd = await window.qclod.pickFolder()
    if (!cwd) return
    const tab = await window.qclod.createTab(cwd)
    setActiveTabId(tab.id)
    setFocusTarget('composer')
  }, [setActiveTabId, setFocusTarget])

  const closeTab = useCallback(
    async (id: TabId) => {
      await window.qclod.closeTab(id)
    },
    []
  )

  const activateTab = useCallback(
    (id: TabId) => {
      setActiveTabId(id)
      void window.qclod.activateTab(id)
    },
    [setActiveTabId]
  )

  useEffect(() => {
    // Route through activateTab so the main process clears the badge too —
    // otherwise a notification click lands on the tab with its dot still lit.
    return window.qclod.onActivateTab((id) => activateTab(id))
  }, [activateTab])

  useTabShortcuts({
    tabs,
    activeTabId,
    onCreate: () => void createTab(),
    onClose: (id) => void closeTab(id),
    onActivate: activateTab
  })

  return (
    <div
      className="app"
      data-testid="app-root"
      // Spec 6.6: files are dropped on the window. The terminal covers most of
      // it, so attaching this to the composer alone would make the obvious
      // target silently inert.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => composerRef.current?.acceptDrop(e)}
    >
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={activateTab}
        onClose={(id) => void closeTab(id)}
        onCreate={() => void createTab()}
        onConfigure={setConfiguringTab}
        hotkey={hotkey}
        onOpenSettings={() => setSettingsOpen((open) => !open)}
      />
      <span hidden>Qclod</span>
      {settings && activeTabId !== '' && (
        <>
          {/*
            Every tab keeps its own live terminal, hidden rather than unmounted:
            re-creating it on each switch would throw away that tab's scrollback.
          */}
          {tabs.map((tab) => (
            <TerminalView
              key={tab.id}
              tabId={tab.id}
              hidden={tab.id !== activeTabId}
              fontSize={settings.fontSize}
              focused={focusTarget === 'terminal' && tab.id === activeTabId}
              onRequestFocus={() => setFocusTarget('terminal')}
              onToggleFocus={toggleFocusTarget}
              onFontSize={setFontSize}
              onMenuActive={onMenuActive}
            />
          ))}
          {sessionDown && activeTab ? (
            <TabErrorPanel
              tab={activeTab}
              onRestart={() => void window.qclod.restart(activeTab.id)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : (
          <Composer
            tabId={activeTabId}
            focused={focusTarget === 'composer'}
            menuActive={menuActive}
            onRequestFocus={() => setFocusTarget('composer')}
            onToggleFocus={toggleFocusTarget}
            dropRef={composerRef}
          />
          )}
        </>
      )}
      {settingsOpen && settings && (
        <SettingsScreen
          settings={settings}
          version={version}
          onPatch={patchGlobalSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {configuringTab !== null && settings && (() => {
        const tab = tabs.find((t) => t.id === configuringTab)
        if (!tab) return null
        return (
          <TabSettingsDialog
            tab={tab}
            globalDefaults={settings.defaults}
            onSave={(overrides) => {
              void window.qclod.updateTab(tab.id, { overrides })
              setConfiguringTab(null)
            }}
            onClose={() => setConfiguringTab(null)}
          />
        )
      })()}
    </div>
  )
}
