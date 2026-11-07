import { useCallback, useEffect, useState } from 'react'
import type { CommandInfo, HotkeyRegistration, SessionSummary } from '../../shared/types'
import { EMPTY_PANEL, useAppStore } from '../state/useAppStore'
import { TitleBar } from '../components/TitleBar'
import { Ribbon } from '../components/Ribbon'
import { Composer } from '../components/Composer'
import { CommandPalette } from '../components/CommandPalette'
import { SidePanel } from '../components/SidePanel'
import { HistoryScreen } from '../components/HistoryScreen'
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
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [recentCommands, setRecentCommands] = useState<string[]>([])
  const settings = useAppStore((s) => s.settings)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const ribbonByTab = useAppStore((s) => s.ribbonByTab)
  const todoByTab = useAppStore((s) => s.todoByTab)
  const draftByTab = useAppStore((s) => s.draftByTab)
  const attachmentsByTab = useAppStore((s) => s.attachmentsByTab)
  const fileIndexByTab = useAppStore((s) => s.fileIndexByTab)
  const panelByTab = useAppStore((s) => s.panelByTab)

  const setSettings = useAppStore((s) => s.setSettings)
  const setTabs = useAppStore((s) => s.setTabs)
  const setActiveTabId = useAppStore((s) => s.setActiveTabId)
  const setRibbon = useAppStore((s) => s.setRibbon)
  const applyRibbon = useAppStore((s) => s.applyRibbon)
  const applyPanel = useAppStore((s) => s.applyPanel)
  const setDraft = useAppStore((s) => s.setDraft)
  const setAttachments = useAppStore((s) => s.setAttachments)
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
      window.qclod.onRibbon((event) => applyRibbon(event.tabId, event.changes)),
      window.qclod.onPanel((event) => applyPanel(event.tabId, event.patch)),
      // The list is live: a plugin installed mid-session changes it.
      window.qclod.onCommandsChanged((event) => {
        if (event.tabId === useAppStore.getState().activeTabId) setCommands(event.commands)
      })
    ]
    return () => {
      for (const off of unsubscribers) off()
    }
  }, [setSettings, setTabs, setActiveTabId, applyRibbon, applyPanel])

  const togglePanel = useCallback((): void => {
    const next = !(useAppStore.getState().settings?.panelOpen ?? true)
    void window.qclod.setSettings({ panelOpen: next }).then(setSettings)
    // Live MCP state is only worth asking for while someone is looking.
    if (next && activeTabId) void window.qclod.panel(activeTabId)
  }, [activeTabId, setSettings])

  /** Opens the panel if needed and puts the cursor on the control. */
  const revealPanelControl = useCallback(
    async (testId: string): Promise<void> => {
      if (!useAppStore.getState().settings?.panelOpen) {
        const next = await window.qclod.setSettings({ panelOpen: true })
        setSettings(next)
      }
      requestAnimationFrame(() => {
        const control = document.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`)
        control?.focus()
        control?.scrollIntoView({ block: 'center' })
      })
    },
    [setSettings]
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePanel, openHistory])

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

  const answerPlan = useCallback(
    (requestId: string, approve: boolean) => {
      if (activeTabId) void window.qclod.answerPlan(activeTabId, requestId, approve)
    },
    [activeTabId]
  )

  /** Shift+Tab walks the everyday modes; «без проверок» is not on the ring. */
  const cycleMode = useCallback((): void => {
    if (!activeTabId) return
    const ring = ['default', 'acceptEdits', 'plan'] as const
    const current = useAppStore.getState().panelByTab[activeTabId]?.permissionMode ?? 'default'
    const at = ring.indexOf(current as (typeof ring)[number])
    void window.qclod.setPermissionMode(activeTabId, ring[(at + 1) % ring.length]!)
  }, [activeTabId])

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
      />
      <div className="app-body">
        <div className="app-main">
      <Ribbon
        items={ribbonByTab[activeTabId] ?? []}
        todo={todoByTab[activeTabId] ?? []}
        onAnswerPermission={answerPermission}
        onAnswerQuestion={answerQuestion}
        onAnswerPlan={answerPlan}
      />
      {activeTabId && (
        <Composer
          tabId={activeTabId}
          status={tabs.find((t) => t.id === activeTabId)?.status ?? 'stopped'}
          draft={draftByTab[activeTabId] ?? ''}
          attachments={attachmentsByTab[activeTabId] ?? []}
          fileIndex={fileIndexByTab[activeTabId] ?? []}
          focusToken={focusToken}
          onDraftChange={(text) => setDraft(activeTabId, text)}
          onAttachmentsChange={(items) => setAttachments(activeTabId, items)}
          onSubmit={(text, attachments) => {
            void window.qclod.send(activeTabId, { text, attachments })
          }}
          onInterrupt={() => void window.qclod.interrupt(activeTabId)}
          onCycleMode={cycleMode}
          onRestart={() => void window.qclod.restartTab(activeTabId)}
          onOpenPalette={() => {
            setPaletteOpen(true)
            void window.qclod.commands(activeTabId).then(setCommands)
          }}
          onPickFiles={() => {
            void window.qclod.pickFiles().then((paths) => {
              if (paths.length === 0) return
              setAttachments(activeTabId, [
                ...(useAppStore.getState().attachmentsByTab[activeTabId] ?? []),
                ...paths.map((path) => ({ kind: 'file' as const, path }))
              ])
            })
          }}
        />
      )}
        </div>
        {settings?.panelOpen && (
          <SidePanel
            data={panelByTab[activeTabId] ?? EMPTY_PANEL}
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
              setDraft(activeTabId, `/${command.name} `)
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
          onPatch={(patch) => {
            void window.qclod.setSettings(patch).then(setSettings)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
