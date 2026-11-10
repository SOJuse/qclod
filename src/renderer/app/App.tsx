import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CommandInfo,
  EnvironmentReport,
  HotkeyRegistration,
  SessionSummary
} from '../../shared/types'
import { EMPTY_PANEL, useAppStore } from '../state/useAppStore'
import { TitleBar } from '../components/TitleBar'
import { ChatPane } from '../components/ChatPane'
import { CommandPalette } from '../components/CommandPalette'
import { SidePanel } from '../components/SidePanel'
import { HistoryScreen } from '../components/HistoryScreen'
import { SetupScreen } from '../components/SetupScreen'
import { isLocalCommand, markUnavailable, needsArgument } from '../../shared/commandFilter'
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null)
  const [setupDismissed, setSetupDismissed] = useState(false)

  const recheck = useCallback((): void => {
    void window.qclod.checkEnvironment().then(setEnvironment)
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
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [recentCommands, setRecentCommands] = useState<string[]>([])
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
      window.qclod.onCommandsChanged((event) => {
        if (event.tabId === useAppStore.getState().activeTabId) setCommands(event.commands)
      })
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

  const togglePanel = useCallback((): void => {
    const next = !(useAppStore.getState().settings?.panelOpen ?? true)
    void window.qclod.setSettings({ panelOpen: next }).then(setSettings)
    if (next && activeTabId) loadPanel(activeTabId)
  }, [activeTabId, setSettings, loadPanel])

  /** Opens the panel if needed and puts the cursor on the control. */
  const revealPanelControl = useCallback(
    async (testId: string): Promise<void> => {
      if (!useAppStore.getState().settings?.panelOpen) {
        const next = await window.qclod.setSettings({ panelOpen: true })
        setSettings(next)
        const id = useAppStore.getState().activeTabId
        if (id) loadPanel(id)
      }
      requestAnimationFrame(() => {
        const control = document.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`)
        control?.focus()
        control?.scrollIntoView({ block: 'center' })
      })
    },
    [setSettings, loadPanel]
  )

  const openHistory = useCallback((): void => {
    if (!activeTabId) return
    setSessions(null)
    setHistoryOpen(true)
    void window.qclod.listHistory(activeTabId).then(setSessions)
  }, [activeTabId])

  // Ctrl+Backslash folds the panel away, Ctrl+H opens the history.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.ctrlKey && ev.code === 'Backslash') {
        ev.preventDefault()
        togglePanel()
      } else if (ev.ctrlKey && ev.code === 'KeyH') {
        ev.preventDefault()
        openHistory()
      } else if (ev.ctrlKey && ev.shiftKey && ev.code === 'Enter') {
        ev.preventDefault()
        toggleSplit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePanel, openHistory, toggleSplit])

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

  const activate = useCallback(
    (id: string) => {
      setActiveTabId(id)
      void window.qclod.activateTab(id)
    },
    [setActiveTabId]
  )



  /** Shift+Tab walks the everyday modes; «без проверок» is not on the ring. */
  const cycleMode = useCallback((): void => {
    if (!activeTabId) return
    const ring = ['default', 'acceptEdits', 'plan'] as const
    const current = useAppStore.getState().panelByTab[activeTabId]?.permissionMode ?? 'default'
    const at = ring.indexOf(current as (typeof ring)[number])
    void window.qclod.setPermissionMode(activeTabId, ring[(at + 1) % ring.length]!)
  }, [activeTabId])


  if (environment && !environment.ready && !setupDismissed) {
    return (
      <SetupScreen
        report={environment}
        onRecheck={recheck}
        onDone={() => setSetupDismissed(true)}
      />
    )
  }

  return (
    <div className="app" data-testid="app-root">
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={activate}
        onClose={(id) => void window.qclod.closeTab(id)}
        onCreate={() => {
          void window.qclod.pickFolder().then((cwd) => {
            if (!cwd) return
            void window.qclod.createTab(cwd).then((tab) => {
              if (tab) activate(tab.id)
            })
          })
        }}
        onConfigure={() => setSettingsOpen(true)}
        hotkey={hotkey}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHistory={openHistory}
        onToggleSplit={toggleSplit}
        splitOpen={splitTabId !== null}
      />
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
            onOpenPalette={() => {
              setPaletteOpen(true)
              void window.qclod.commands(activeTabId).then(setCommands)
            }}
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
              onOpenPalette={() => {
                setPaletteOpen(true)
                void window.qclod.commands(splitTabId).then(setCommands)
              }}
            />
          )}
        </div>
        {settings?.panelOpen && (
          <SidePanel
            data={panelByTab[activeTabId] ?? EMPTY_PANEL}
            agents={agentRuns}
            started={(tabs.find((t) => t.id === activeTabId)?.status ?? 'stopped') !== 'stopped'}
            onSetMode={(mode) => {
              if (activeTabId) void window.qclod.setPermissionMode(activeTabId, mode)
            }}
            onSetModel={(model) => {
              if (activeTabId) void window.qclod.setModel(activeTabId, model)
            }}
            onSetEffort={(level) => {
              if (activeTabId) void window.qclod.setEffort(activeTabId, level)
            }}
            onClose={togglePanel}
          />
        )}
        {!settings?.panelOpen && (
          <button
            type="button"
            className="panel-reopen"
            data-testid="panel-open"
            aria-label="Показать панель"
            onClick={togglePanel}
          >
            ‹
          </button>
        )}
      </div>
      {paletteOpen && (
        <CommandPalette
          commands={markUnavailable(commands)}
          recent={recentCommands}
          onClose={() => {
            setPaletteOpen(false)
            setFocusToken((n) => n + 1)
          }}
          onPick={(command) => {
            setPaletteOpen(false)
            setRecentCommands((names) =>
              [command.name, ...names.filter((n) => n !== command.name)].slice(0, 6)
            )

            // Some commands are ours to answer. /resume opens an interactive
            // picker the terminal has and a headless session does not; /model
            // and /effort need a value, and the panel already knows the real
            // list to choose from.
            if (isLocalCommand(command.name)) {
              if (command.name === 'resume') openHistory()
              else void revealPanelControl(command.name === 'model' ? 'panel-model' : 'panel-effort')
              return
            }

            // A command that needs an argument is put in the input rather than
            // sent half-finished.
            if (needsArgument(command)) {
              useAppStore.getState().setDraft(activeTabId, `/${command.name} `)
              setFocusToken((n) => n + 1)
              return
            }

            setFocusToken((n) => n + 1)
            void window.qclod.send(activeTabId, {
              text: `/${command.name}`,
              attachments: []
            })
          }}
        />
      )}
      {historyOpen && (
        <HistoryScreen
          cwd={tabs.find((t) => t.id === activeTabId)?.cwd ?? ''}
          sessions={sessions}
          onClose={() => {
            setHistoryOpen(false)
            setFocusToken((n) => n + 1)
          }}
          onOpen={(session) => {
            setHistoryOpen(false)
            void window.qclod.openHistory(activeTabId, session.id, session.title).then((tab) => {
              if (tab) activate(tab.id)
            })
          }}
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
        />
      )}
    </div>
  )
}
