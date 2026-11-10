import { PanelRightOpen } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  EnvironmentReport,
  HotkeyRegistration,
  SessionSummary
} from '../../shared/types'
import { EMPTY_PANEL, useAppStore } from '../state/useAppStore'
import { TitleBar } from '../components/TitleBar'
import { ChatPane } from '../components/ChatPane'
import { SidePanel } from '../components/SidePanel'
import { HistoryScreen } from '../components/HistoryScreen'
import { SetupScreen } from '../components/SetupScreen'
import { SettingsScreen } from '../components/SettingsScreen'
import { ActionPalette } from '../components/ActionPalette'
import { UpdateBanner } from '../components/UpdateBanner'
import { compactNow } from '../input/slash'
import { hint, resolveAppShortcut, tabAtTarget, type AppActionId } from './shortcuts'
import { PANEL_MIN_WIDTH, nextOverride, panelVisible, type PanelOverride } from './panelVisibility'
import './App.css'

/**
 * The window: tabs across the top, the conversation below.
 *
 * Owns the shortcuts, the panel, the history and settings screens; each
 * conversation is a ChatPane.
 */
export function App(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [hotkey, setHotkey] = useState<HotkeyRegistration | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  /** Where focus goes when a closed sheet's opener is gone: the active tab's input. */
  const focusComposer = useCallback(() => setFocusToken((n) => n + 1), [])
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null)
  const [setupDismissed, setSetupDismissed] = useState(false)
  /**
   * Set by the first report that was not ready. The screen then stays until
   * «Начать работу», so finishing step 2 is seen rather than skipped past.
   */
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** Ctrl+W was pressed once on a working tab; a second press within 3 s closes it. */
  const [closeGuardTab, setCloseGuardTab] = useState<string | null>(null)
  const closeGuardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * The window's width, and a panel choice made in a narrow window. That
   * choice lasts until the window crosses the threshold; it is never saved.
   */
  const [width, setWidth] = useState(() => window.innerWidth)
  const widthRef = useRef(width)
  const [panelOverride, setPanelOverride] = useState<PanelOverride>(null)
  useEffect(() => {
    const onResize = (): void => {
      const before = widthRef.current
      const after = window.innerWidth
      widthRef.current = after
      setPanelOverride((override) => nextOverride(override, before, after))
      setWidth(after)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const recheck = useCallback((): void => {
    void window.qclod.checkEnvironment().then((report) => {
      setEnvironment(report)
      if (!report.ready) setSetupNeeded(true)
    })
  }, [])

  // Checked once at start: without Claude Code on the machine there is nothing
  // to drive, and finding that out by typing a message is a poor welcome.
  useEffect(recheck, [recheck])
  const splitTabId = useAppStore((s) => s.splitTabId)
  const setSplitTabId = useAppStore((s) => s.setSplitTabId)

  // The session's subagents, read from the ribbon it already holds.
  const activeRibbon = useAppStore((state) => state.ribbonByTab[state.activeTabId])
  const agentRuns = useMemo(
    () =>
      (activeRibbon ?? [])
        .filter((item) => item.kind === 'subagent')
        .map((item) => {
          const run = item as Extract<typeof item, { kind: 'subagent' }>
          return {
            id: run.id,
            name: run.name,
            task: run.task,
            state: run.state,
            ...(run.tokens ? { tokens: run.tokens } : {}),
            ...(run.durationMs ? { durationMs: run.durationMs } : {}),
            ...(run.toolCalls ? { toolCalls: run.toolCalls } : {}),
            ...(run.lastTool ? { lastTool: run.lastTool } : {}),
            ...(run.summary ? { summary: run.summary } : {})
          }
        }),
    [activeRibbon]
  )

  const swapPanes = useCallback((): void => {
    const state = useAppStore.getState()
    const other = state.splitTabId
    if (!other) return
    setSplitTabId(state.activeTabId)
    state.setActiveTabId(other)
    setFocusToken((n) => n + 1)
  }, [setSplitTabId])

  /** Opens the conversation beside this one, or closes the second pane. */
  const toggleSplit = useCallback((): void => {
    const state = useAppStore.getState()
    if (state.splitTabId) {
      setSplitTabId(null)
      return
    }
    const other = state.tabs.find((t) => t.id !== state.activeTabId)
    if (!other) return
    setSplitTabId(other.id)
    void window.qclod.activateTab(other.id)
  }, [setSplitTabId])
  const settings = useAppStore((s) => s.settings)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const fileIndexByTab = useAppStore((s) => s.fileIndexByTab)
  const panelByTab = useAppStore((s) => s.panelByTab)

  const setSettings = useAppStore((s) => s.setSettings)
  const setTabs = useAppStore((s) => s.setTabs)
  const setActiveTabId = useAppStore((s) => s.setActiveTabId)
  const setRibbon = useAppStore((s) => s.setRibbon)
  const applyRibbon = useAppStore((s) => s.applyRibbon)
  const applyPanel = useAppStore((s) => s.applyPanel)
  const setPanelSnapshot = useAppStore((s) => s.setPanelSnapshot)
  const setFileIndex = useAppStore((s) => s.setFileIndex)

  useEffect(() => {
    void window.qclod.getSettings().then(setSettings)
    void window.qclod.listTabs().then(setTabs)
    void window.qclod.appVersion().then(setVersion)
    void window.qclod.hotkeyStatus().then(setHotkey)

    const unsubscribers = [
      window.qclod.onSettingsChanged(setSettings),
      window.qclod.onTabsChanged(setTabs),
      window.qclod.onActivateTab((id) => setActiveTabId(id)),
      window.qclod.onRibbon((event) => applyRibbon(event.tabId, event.changes, event.rev)),
      window.qclod.onPanel((event) => applyPanel(event.tabId, event.patch, event.rev)),
      // The list is live: a plugin installed mid-session changes it.
      window.qclod.onCommandsChanged((event) =>
        useAppStore.getState().setCommands(event.tabId, event.commands)
      )
    ]
    return () => {
      for (const off of unsubscribers) off()
    }
  }, [setSettings, setTabs, setActiveTabId, applyRibbon, applyPanel])

  /**
   * Asks for a tab's whole panel. Events alone are not enough: a reloaded
   * window, or one that opened after the session started, has missed the ones
   * that filled it. The main process also asks for live MCP state, which
   * follows as an event.
   */
  const loadPanel = useCallback(
    (id: string): void => {
      void window.qclod.panel(id).then((snapshot) => setPanelSnapshot(id, snapshot))
    },
    [setPanelSnapshot]
  )

  // On mount and on every switch, for both panes.
  useEffect(() => {
    if (activeTabId) loadPanel(activeTabId)
  }, [activeTabId, loadPanel])
  useEffect(() => {
    if (splitTabId) loadPanel(splitTabId)
  }, [splitTabId, loadPanel])

  /**
   * The panel button. In a wide window it flips the saved setting; in a
   * narrow one, where the panel folds by itself, it opens or closes it for
   * this window only.
   */
  const togglePanel = useCallback((): void => {
    const setting = useAppStore.getState().settings?.panelOpen === true
    const visible = panelVisible({ setting, width: widthRef.current, override: panelOverride })
    if (widthRef.current < PANEL_MIN_WIDTH) {
      setPanelOverride(visible ? 'closed' : 'open')
    } else {
      setPanelOverride(null)
      void window.qclod.setSettings({ panelOpen: !visible }).then(setSettings)
    }
    if (!visible && activeTabId) loadPanel(activeTabId)
  }, [activeTabId, panelOverride, setSettings, loadPanel])

  const showPanel = panelVisible({
    setting: settings?.panelOpen === true,
    width,
    override: panelOverride
  })

  const openHistory = useCallback((): void => {
    if (!activeTabId) return
    setSessions(null)
    setHistoryOpen(true)
    void window.qclod.listHistory(activeTabId).then(setSessions)
  }, [activeTabId])

  /** Shift+Tab walks the everyday modes; «без проверок» is not on the ring. */
  const cycleMode = useCallback((): void => {
    if (!activeTabId) return
    const ring = ['default', 'acceptEdits', 'plan'] as const
    const current = useAppStore.getState().panelByTab[activeTabId]?.permissionMode ?? 'default'
    const at = ring.indexOf(current as (typeof ring)[number])
    void window.qclod.setPermissionMode(activeTabId, ring[(at + 1) % ring.length]!)
  }, [activeTabId])

  const activate = useCallback(
    (id: string) => {
      setActiveTabId(id)
      void window.qclod.activateTab(id)
    },
    [setActiveTabId]
  )

  /** A past conversation opens in a new tab through the same resume path a restart uses. */
  const openSession = useCallback(
    (fromTabId: string, session: SessionSummary): void => {
      void window.qclod.openHistory(fromTabId, session.id, session.title).then((tab) => {
        if (tab) activate(tab.id)
      })
    },
    [activate]
  )

  const newTab = useCallback((): void => {
    void window.qclod.pickFolder().then((cwd) => {
      if (!cwd) return
      void window.qclod.createTab(cwd).then((tab) => {
        if (tab) activate(tab.id)
      })
    })
  }, [activate])

  const clearCloseGuard = useCallback((): void => {
    if (closeGuardTimer.current) clearTimeout(closeGuardTimer.current)
    closeGuardTimer.current = null
    setCloseGuardTab(null)
  }, [])
  useEffect(() => () => {
    if (closeGuardTimer.current) clearTimeout(closeGuardTimer.current)
  }, [])
  // The warning is about one tab; switching away forgets it.
  useEffect(clearCloseGuard, [activeTabId, clearCloseGuard])

  /** Ctrl+W: a working tab asks for a second press, so a stray key cannot kill a run. */
  const closeActiveTab = useCallback((): void => {
    const state = useAppStore.getState()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    if (!tab) return
    const working = tab.status === 'busy' || tab.status === 'waiting'
    if (working && closeGuardTimer.current === null) {
      setCloseGuardTab(tab.id)
      closeGuardTimer.current = setTimeout(clearCloseGuard, 3000)
      return
    }
    clearCloseGuard()
    void window.qclod.closeTab(tab.id)
  }, [clearCloseGuard])

  const restartSession = useCallback((): void => {
    const id = useAppStore.getState().activeTabId
    if (!id) return
    // The new session's panel replaces the old one's whole.
    void window.qclod
      .restartTab(id)
      .then(() => window.qclod.panel(id))
      .then((snapshot) => setPanelSnapshot(id, snapshot))
  }, [setPanelSnapshot])

  /** The one place every shortcut and every Ctrl+K row ends up. */
  const runAction = useCallback(
    (id: AppActionId, index?: number): void => {
      const state = useAppStore.getState()
      const at = state.tabs.findIndex((t) => t.id === state.activeTabId)
      const step = (delta: number): void => {
        if (state.tabs.length < 2 || at < 0) return
        activate(state.tabs[(at + delta + state.tabs.length) % state.tabs.length]!.id)
      }
      switch (id) {
        case 'newTab':
          return newTab()
        case 'closeTab':
          return closeActiveTab()
        case 'nextTab':
          return step(1)
        case 'prevTab':
          return step(-1)
        case 'tabAt': {
          const target = tabAtTarget(state.tabs.map((t) => t.id), index)
          if (target) activate(target)
          return
        }
        case 'actions':
          if (paletteRef.current) setFocusToken((n) => n + 1)
          return setPaletteOpen((open) => !open)
        case 'settings':
          return setSettingsOpen(true)
        case 'history':
          return openHistory()
        case 'togglePanel':
          return togglePanel()
        case 'toggleSplit':
          return toggleSplit()
        case 'restart':
          return restartSession()
        case 'compact':
          if (state.activeTabId) compactNow(state.activeTabId)
          return
        case 'cycleMode':
          return cycleMode()
        case 'zoomIn':
          return void window.qclod.zoom('in')
        case 'zoomOut':
          return void window.qclod.zoom('out')
        case 'zoomReset':
          return void window.qclod.zoom('reset')
        case 'reload':
          return void window.qclod.reloadWindow()
      }
    },
    [activate, newTab, closeActiveTab, openHistory, togglePanel, toggleSplit, restartSession, cycleMode]
  )

  // Window-level shortcuts, by physical key. The handler is registered once and
  // reads the latest runAction through a ref.
  const runRef = useRef(runAction)
  runRef.current = runAction
  const paletteRef = useRef(paletteOpen)
  paletteRef.current = paletteOpen
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const hit = resolveAppShortcut(ev)
      if (!hit) return
      // Always ours, so no default (Close Window, Reload…) sees the key.
      ev.preventDefault()
      // A held Ctrl+R must not reload again and again.
      if (hit.id === 'reload' && ev.repeat) return
      // With the palette open only Ctrl+K (to close it) runs.
      if (paletteRef.current && hit.id !== 'actions') return
      runRef.current(hit.id, hit.index)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The file index backs @-mentions; it is per folder, so it is fetched once
  // per tab rather than on every keystroke.
  useEffect(() => {
    if (!activeTabId || fileIndexByTab[activeTabId]) return
    void window.qclod.fileIndex(activeTabId).then((paths) => setFileIndex(activeTabId, paths))
  }, [activeTabId, fileIndexByTab, setFileIndex])

  // The first tab the main process reports is the one to show.
  useEffect(() => {
    if (!activeTabId && tabs.length > 0) setActiveTabId(tabs[0]!.id)
  }, [tabs, activeTabId, setActiveTabId])

  /**
   * Asks for a tab's whole ribbon, once per tab for the life of this window.
   * A reloaded window, or one shown a tab for the first time, has missed the
   * events that built it. The snapshot and the events still in flight are
   * ordered by revision in the store, so whichever lands first, nothing is
   * shown twice or lost; after it, the events alone keep the tab current.
   */
  const ribbonsAsked = useRef(new Set<string>())
  // A closed tab is asked again if its id ever comes back.
  useEffect(() => {
    const open = new Set(tabs.map((t) => t.id))
    for (const id of ribbonsAsked.current) if (!open.has(id)) ribbonsAsked.current.delete(id)
  }, [tabs])
  const loadRibbon = useCallback(
    (id: string): void => {
      if (ribbonsAsked.current.has(id)) return
      ribbonsAsked.current.add(id)
      void window.qclod.ribbon(id).then((snapshot) => setRibbon(id, snapshot))
    },
    [setRibbon]
  )

  // On mount and on every switch, for both panes — as the panel is.
  useEffect(() => {
    if (activeTabId) loadRibbon(activeTabId)
  }, [activeTabId, loadRibbon])
  useEffect(() => {
    if (splitTabId) loadRibbon(splitTabId)
  }, [splitTabId, loadRibbon])

  if (environment && setupNeeded && !setupDismissed) {
    // Settings open over the setup screen; closing them checks again, since
    // the agent path is what they were opened for.
    return (
      <>
        <SetupScreen
          report={environment}
          onRecheck={recheck}
          onDone={() => setSetupDismissed(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {settingsOpen && settings && (
          <SettingsScreen
            settings={settings}
            version={version}
            models={[]}
            focusField="agentPath"
            onPatch={async (patch) => {
              const next = await window.qclod.setSettings(patch)
              setSettings(next)
              return next
            }}
            onClose={() => {
              setSettingsOpen(false)
              recheck()
            }}
          />
        )}
      </>
    )
  }

  return (
    <div className="app" data-testid="app-root">
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={activate}
        onClose={(id) => {
          clearCloseGuard()
          void window.qclod.closeTab(id)
        }}
        onCreate={newTab}
        hotkey={hotkey}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHistory={openHistory}
        onToggleSplit={toggleSplit}
        splitOpen={splitTabId !== null}
      />
      <UpdateBanner />
      <div className={`app-body${splitTabId ? ' app-split' : ''}`}>
        <div className="app-panes">
          <ChatPane
            tabId={activeTabId}
            focused={true}
            focusToken={focusToken}
            title={tabs.find((t) => t.id === activeTabId)?.title ?? ''}
            showTitle={splitTabId !== null}
            onFocus={() => undefined}
            onCycleMode={cycleMode}
            onOpenHistory={openHistory}
            onOpenSession={openSession}
            notice={
              closeGuardTab === activeTabId
                ? { testId: 'close-guard', text: 'Агент работает — Ctrl+W ещё раз закроет вкладку' }
                : null
            }
          />
          {splitTabId && (
            <ChatPane
              tabId={splitTabId}
              focused={false}
              focusToken={focusToken}
              title={tabs.find((t) => t.id === splitTabId)?.title ?? ''}
              showTitle
              // Clicking the other pane makes it the one everything acts on.
              onFocus={() => swapPanes()}
              onCycleMode={cycleMode}
              onOpenHistory={openHistory}
              onOpenSession={openSession}
            />
          )}
        </div>
        {showPanel && (
          <SidePanel
            data={panelByTab[activeTabId] ?? EMPTY_PANEL}
            agents={agentRuns}
            started={(tabs.find((t) => t.id === activeTabId)?.status ?? 'stopped') !== 'stopped'}
            onClose={togglePanel}
          />
        )}
        {!showPanel && (
          <button
            type="button"
            className="panel-reopen"
            data-testid="panel-open"
            aria-label="Показать панель"
            title={hint('Показать панель', 'togglePanel')}
            onClick={togglePanel}
          >
            <PanelRightOpen size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {historyOpen && (
        <HistoryScreen
          cwd={tabs.find((t) => t.id === activeTabId)?.cwd ?? ''}
          sessions={sessions}
          onClose={() => setHistoryOpen(false)}
          onFocusLost={focusComposer}
          onOpen={(session) => {
            setHistoryOpen(false)
            openSession(activeTabId, session)
          }}
        />
      )}
      {paletteOpen && (
        <ActionPalette
          onRun={(id) => {
            setPaletteOpen(false)
            setFocusToken((n) => n + 1)
            runAction(id)
          }}
          onClose={() => setPaletteOpen(false)}
          onFocusLost={focusComposer}
        />
      )}
      {settingsOpen && settings && (
        <SettingsScreen
          settings={settings}
          version={version}
          models={(activeTabId ? panelByTab[activeTabId]?.models : undefined) ?? []}
          onPatch={async (patch) => {
            const next = await window.qclod.setSettings(patch)
            setSettings(next)
            return next
          }}
          onClose={() => setSettingsOpen(false)}
          onFocusLost={focusComposer}
        />
      )}
    </div>
  )
}
