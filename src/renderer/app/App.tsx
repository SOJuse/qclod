import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EnvironmentReport, HotkeyRegistration, SessionSummary } from '../../shared/types'
import { useAppStore } from '../state/useAppStore'
import { startLayoutSync } from '../state/layoutSync'
import { MAX_PANES, buildSidebar, chatOrder, nextPanes } from '../chat/sidebarModel'
import { SplitView } from './SplitView'
import { dropOnPane, type DropPayload, type DropWhere } from './paneOps'
import { openAndPlace } from './dropSession'
import { restartChat } from './restartChat'
import { SetupTitleBar, TitleBar } from '../components/TitleBar'
import { Sidebar } from '../components/sidebar/Sidebar'
import { ChatPane, type PanelRequest } from '../components/ChatPane'
import { useVoiceHotkey } from '../voice/useVoiceHotkey'
import { toggleVoice } from '../voice/voiceStore'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { SetupScreen } from '../components/SetupScreen'
import { SettingsScreen } from '../components/SettingsScreen'
import { CommandPalette } from '../components/CommandPalette'
import { historyToLoad } from '../palette/history'
import { withMention } from '../palette/files'
import { withCommand } from '../palette/commands'
import type { PaletteContext, PaletteRunner, PaletteSection } from '../palette/types'
import { withLocalCommands } from '../../shared/commandFilter'
import { UpdateBanner } from '../components/UpdateBanner'
import { compactNow } from '../input/slash'
import { reasonOf } from '../ui/StateView'
import { actionKeys, resolveAppShortcut, tabAtTarget, type AppActionId } from './shortcuts'
import './App.css'

/** A failed first read of the tabs is asked once more after this long. */
const TABS_RETRY_MS = 500

/** The map without one key; the same object when the key is not there. */
function without(all: Record<string, string>, id: string): Record<string, string> {
  if (!(id in all)) return all
  const { [id]: _gone, ...rest } = all
  return rest
}

/**
 * e2e only: the first pane of a split throws while drawing (preload reads the
 * flag under the test seams). Only in a split: a lone pane that throws from
 * the start leaves no window to drive and no second pane to see alive.
 * Rendered only under `__QCLOD_TEST_SEAMS__`, so a release drops it whole.
 */
function ThrowInPane(): null {
  if (window.qclod.throwInPane) throw new Error('e2e: render error in a pane')
  return null
}

/**
 * The window: projects and their chats on the left, the conversation beside them.
 *
 * Owns the shortcuts, the sidebar and the settings screen; each conversation
 * is a ChatPane, with its own right-hand panel.
 */
export function App(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** The section the settings open on, when something asked for one («Настройки голоса»). */
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined)
  const [version, setVersion] = useState('')
  const [hotkey, setHotkey] = useState<HotkeyRegistration | null>(null)
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
  /** Ctrl+K, open: kept to one section or not; `n` tells one opening from the next. */
  const [palette, setPalette] = useState<{ scope?: PaletteSection; n: number } | null>(null)
  /** Ctrl+W was pressed once on a working tab; a second press within 3 s closes it. */
  const [closeGuardTab, setCloseGuardTab] = useState<string | null>(null)
  const closeGuardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * The last Ctrl+\: the active pane opens or closes its own panel. The
   * number tells a new request from an old one.
   */
  const [panelRequest, setPanelRequest] = useState<PanelRequest | null>(null)
  const togglePanel = useCallback((): void => {
    const tabId = useAppStore.getState().activeTabId
    if (tabId) setPanelRequest((was) => ({ tabId, n: (was?.n ?? 0) + 1 }))
  }, [])

  /** A check is under way: «Проверить снова» says so and waits. */
  const [checking, setChecking] = useState(false)
  /** Why the last check could not run; the setup screen says so in one line. */
  const [checkError, setCheckError] = useState<string | null>(null)
  const recheck = useCallback((): void => {
    setChecking(true)
    window.qclod
      .checkEnvironment()
      .then(
        (report) => {
          setCheckError(null)
          setEnvironment(report)
          if (!report.ready) setSetupNeeded(true)
        },
        // A check that could not run changes nothing: the last report stays, and the reason is shown.
        (err) => {
          console.warn('[setup] check failed:', reasonOf(err))
          setCheckError(reasonOf(err))
        }
      )
      .finally(() => setChecking(false))
  }, [])

  // Checked once at start: without Claude Code on the machine there is nothing
  // to drive, and finding that out by typing a message is a poor welcome.
  useEffect(recheck, [recheck])
  const paneTabIds = useAppStore((s) => s.paneTabIds)
  const paneWidths = useAppStore((s) => s.paneWidths)
  const setPanes = useAppStore((s) => s.setPanes)
  const setPaneWidths = useAppStore((s) => s.setPaneWidths)
  // Main keeps the layout; the window follows it and writes its pane changes back.
  useEffect(() => startLayoutSync(useAppStore, window.qclod), [])
  const split = paneTabIds.length > 1

  /** A click on a pane: it becomes the one everything acts on, and no pane moves. */
  const focusPane = useCallback((id: string): void => {
    const state = useAppStore.getState()
    if (state.activeTabId === id) return
    state.focusPane(id)
    void window.qclod.activateTab(id)
    setFocusToken((n) => n + 1)
  }, [])

  /** Sets the panes; when that changes the active chat, main is told, as with a click. */
  const applyPanes = useCallback(
    (ids: string[]): void => {
      const { activate } = nextPanes(useAppStore.getState(), ids)
      setPanes(ids)
      if (activate) void window.qclod.activateTab(activate)
    },
    [setPanes]
  )

  /**
   * Closes the split down to the active pane; with one pane, opens beside it
   * the next chat of the sidebar's order that is not shown, and moves there.
   */
  const toggleSplit = useCallback((): void => {
    const state = useAppStore.getState()
    if (state.paneTabIds.length > 1) {
      applyPanes([state.activeTabId])
      return
    }
    const order = chatOrder(buildSidebar(state.tabs, state.layout.projects, state.historyByProject))
    const at = order.indexOf(state.activeTabId)
    const other = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))].find(
      (id) => id !== state.activeTabId && !state.paneTabIds.includes(id)
    )
    if (!other) return
    applyPanes([state.activeTabId, other])
    focusPane(other)
  }, [applyPanes, focusPane])

  /** The panes as drawn: before any tab is known, the active id alone. */
  const shownPanes = useCallback((): string[] => {
    const state = useAppStore.getState()
    return state.paneTabIds.length > 0 ? state.paneTabIds : [state.activeTabId]
  }, [])

  /** `id` let go on pane `index` of the row `before`: it takes its place there and is the active one. */
  const placeDropped = useCallback(
    (before: string[], id: string, index: number, where: DropWhere): void => {
      const next = dropOnPane(before, id, index, where)
      // On itself, or beside a full row: nothing at all changes.
      if (next === before) return
      applyPanes(next)
      focusPane(id)
    },
    [applyPanes, focusPane]
  )

  /**
   * A drop on the split. A chat moves or comes in (paneOps.dropOnPane). A past
   * conversation is opened first, then put where it was let go — into the row
   * as it was at the drop, whatever main made of the opening meanwhile.
   */
  const dropOnSplit = useCallback(
    (index: number, where: DropWhere, payload: DropPayload): void => {
      const before = shownPanes()
      if (payload.kind === 'chat') {
        if (!useAppStore.getState().tabs.some((t) => t.id === payload.tabId)) return
        placeDropped(before, payload.tabId, index, where)
        return
      }
      // A full row has no room beside a pane: nothing is opened for nowhere.
      if (before.length >= MAX_PANES && where !== 'replace') return
      // Placed only once its chat is in the tab list, whichever of main's messages comes first.
      void openAndPlace({
        store: useAppStore,
        open: () => window.qclod.openProjectSession(payload.cwd, payload.sessionId, payload.title),
        place: (id) => placeDropped(before, id, index, where)
      })
    },
    [shownPanes, placeDropped]
  )
  const settings = useAppStore((s) => s.settings)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const fileIndexByTab = useAppStore((s) => s.fileIndexByTab)
  const commandsByTab = useAppStore((s) => s.commandsByTab)
  const panelByTab = useAppStore((s) => s.panelByTab)
  const layout = useAppStore((s) => s.layout)
  const historyByProject = useAppStore((s) => s.historyByProject)
  const loadProjectHistory = useAppStore((s) => s.loadProjectHistory)
  const sidebar = useMemo(
    () => buildSidebar(tabs, layout.projects, historyByProject),
    [tabs, layout.projects, historyByProject]
  )
  const sidebarOpen = !layout.sidebarCollapsed

  // A project's past conversations are asked for the first time it is shown open.
  useEffect(() => {
    for (const project of sidebar) if (!project.collapsed && project.past === null) loadProjectHistory(project.cwd)
  }, [sidebar, loadProjectHistory])

  const setSettings = useAppStore((s) => s.setSettings)
  const setTabs = useAppStore((s) => s.setTabs)
  const setActiveTabId = useAppStore((s) => s.setActiveTabId)
  const setRibbon = useAppStore((s) => s.setRibbon)
  const applyRibbon = useAppStore((s) => s.applyRibbon)
  const applyPanel = useAppStore((s) => s.applyPanel)
  const setPanelSnapshot = useAppStore((s) => s.setPanelSnapshot)
  const setFileIndex = useAppStore((s) => s.setFileIndex)

  /** Why the settings could not be read; the settings sheet shows it with «Повторить». */
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const loadSettings = useCallback((): void => {
    setSettingsError(null)
    window.qclod.getSettings().then(setSettings, (err) => setSettingsError(reasonOf(err)))
  }, [setSettings])

  useEffect(() => {
    loadSettings()
    // Neither read is fatal. The tabs are asked once more and also arrive by
    // their push; without a version the settings sheet leaves it out.
    let tabsRetry: ReturnType<typeof setTimeout> | undefined
    window.qclod.listTabs().then(setTabs, () => {
      tabsRetry = setTimeout(() => window.qclod.listTabs().then(setTabs, () => undefined), TABS_RETRY_MS)
    })
    window.qclod.appVersion().then(setVersion, () => setVersion(''))
    // The title bar only hints with it; the settings sheet reports a failure itself.
    window.qclod.hotkeyStatus().then(setHotkey, () => setHotkey(null))

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
      clearTimeout(tabsRetry)
      for (const off of unsubscribers) off()
    }
  }, [loadSettings, setSettings, setTabs, setActiveTabId, applyRibbon, applyPanel])

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
    for (const id of paneTabIds) loadPanel(id)
  }, [paneTabIds, loadPanel])

  const toggleSidebar = useCallback((): void => {
    void window.qclod.setLayout({ sidebarCollapsed: !useAppStore.getState().layout.sidebarCollapsed })
  }, [])

  const toggleProject = useCallback(
    (cwd: string, collapsed: boolean): void => {
      void window.qclod.setLayout({ projectCollapsed: { cwd, collapsed } })
      if (!collapsed) loadProjectHistory(cwd)
    },
    [loadProjectHistory]
  )

  /**
   * Ctrl+K: the search over everything; Ctrl+H and /resume: the same kept to
   * the past conversations. Opening reads the history of the projects nobody
   * asked about yet. Ctrl+K on an open palette closes it; Ctrl+H there opens it
   * afresh, kept to the past ones (the chip may have been taken off meanwhile).
   */
  const togglePalette = useCallback((scope?: PaletteSection): void => {
    const was = paletteRef.current
    if (was && scope === undefined) {
      setFocusToken((n) => n + 1)
      return setPalette(null)
    }
    const state = useAppStore.getState()
    const sidebarNow = buildSidebar(state.tabs, state.layout.projects, state.historyByProject)
    for (const cwd of historyToLoad(sidebarNow)) state.loadProjectHistory(cwd)
    setPalette({ ...(scope === undefined ? {} : { scope }), n: (was?.n ?? 0) + 1 })
  }, [])

  /** Shift+Tab walks the everyday modes; «без проверок» is not on the ring. */
  const cycleMode = useCallback((): void => {
    if (!activeTabId) return
    // «Авто-да» is not on it either: one stray key must not turn the asking off.
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

  /** A new chat in this folder; without one, the folder is asked for first. */
  const newChat = useCallback(
    (cwd?: string): void => {
      const create = (folder: string): void => {
        void window.qclod.createTab(folder).then((tab) => {
          if (tab) activate(tab.id)
        })
      }
      if (cwd) return create(cwd)
      void window.qclod.pickFolder().then((picked) => {
        if (picked) create(picked)
      })
    },
    [activate]
  )

  /** A past conversation from the sidebar: its own chat, or the open one that already holds it. */
  const openPast = useCallback(
    (cwd: string, session: SessionSummary): void => {
      window.qclod.openProjectSession(cwd, session.id, session.title).then(
        (tab) => {
          if (tab) activate(tab.id)
        },
        (err: unknown) => console.warn('[sidebar] разговор не открылся:', reasonOf(err))
      )
    },
    [activate]
  )

  /** Closes a chat; its conversation then belongs under «Прошлые», so the project's history is read again. */
  const closeChat = useCallback(
    (id: string): void => {
      const cwd = useAppStore.getState().tabs.find((t) => t.id === id)?.cwd
      void window.qclod.closeTab(id).then(() => {
        if (cwd) loadProjectHistory(cwd, true)
      })
    },
    [loadProjectHistory]
  )

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
    closeChat(tab.id)
  }, [clearCloseGuard, closeChat])

  const restartSession = useCallback((): void => {
    const id = useAppStore.getState().activeTabId
    // A new session, its own panel, and the project's history read again.
    if (id) void restartChat(id)
  }, [])

  /**
   * The one place every shortcut and every Ctrl+K row ends up. `at` is Ctrl+1…9's
   * index, or the object of an action a later stage adds (a server's id, этап 6).
   */
  const runAction = useCallback(
    (id: AppActionId, at?: number | string): void => {
      const state = useAppStore.getState()
      // The sidebar's order, top to bottom: what the person sees.
      const order = chatOrder(buildSidebar(state.tabs, state.layout.projects, state.historyByProject))
      const here = order.indexOf(state.activeTabId)
      const step = (delta: number): void => {
        if (order.length < 2 || here < 0) return
        activate(order[(here + delta + order.length) % order.length]!)
      }
      switch (id) {
        case 'newTab':
          return newChat()
        case 'closeTab':
          return closeActiveTab()
        case 'nextTab':
          return step(1)
        case 'prevTab':
          return step(-1)
        case 'tabAt': {
          const target = tabAtTarget(order, typeof at === 'number' ? at : undefined)
          if (target) activate(target)
          return
        }
        case 'actions':
          return togglePalette()
        case 'settings':
          return setSettingsOpen(true)
        case 'history':
          return togglePalette('history')
        case 'togglePanel':
          return togglePanel()
        case 'toggleSidebar':
          return toggleSidebar()
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
        case 'voice':
          // A short press on the active pane: start, or stop (этап 5).
          if (state.activeTabId) toggleVoice(state.activeTabId)
          return
      }
    },
    [activate, newChat, closeActiveTab, togglePalette, togglePanel, toggleSidebar, toggleSplit, restartSession, cycleMode]
  )

  /** What a Ctrl+K row does; the palette has closed by then, and focus goes back to the input. */
  const paletteRun = useMemo((): PaletteRunner => {
    const intoDraft = (edit: (draft: string) => string): void => {
      const state = useAppStore.getState()
      if (state.activeTabId) state.setDraft(state.activeTabId, edit(state.draftByTab[state.activeTabId] ?? ''))
    }
    const focused =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A): void => {
        focusComposer()
        fn(...args)
      }
    return {
      activateChat: focused(activate),
      openProject: focused((cwd: string) => newChat(cwd)),
      openSession: focused(openPast),
      insertMention: focused((path: string) => intoDraft((draft) => withMention(draft, path))),
      insertCommand: focused((name: string) => intoDraft((draft) => withCommand(draft, name))),
      runAction: focused((id: AppActionId, arg?: string) => runAction(id, arg)),
      openLayer: (layer) => {
        const state = useAppStore.getState()
        if (state.activeTabId) state.setPaneLayer(state.activeTabId, layer)
      },
      loadHistory: (cwd) => loadProjectHistory(cwd)
    }
  }, [activate, newChat, openPast, runAction, focusComposer, loadProjectHistory])

  /** What Ctrl+K searches, live while it is open: a history read that lands shows at once. */
  const paletteCtx = useMemo(
    (): PaletteContext | null =>
      palette && {
        sidebar,
        activeTabId,
        files: fileIndexByTab[activeTabId] ?? [],
        filesPending: fileIndexByTab[activeTabId] === undefined,
        commands: withLocalCommands(commandsByTab[activeTabId] ?? []),
        run: paletteRun
      },
    [palette, sidebar, activeTabId, fileIndexByTab, commandsByTab, paletteRun]
  )

  // Window-level shortcuts, by physical key. The handler is registered once and
  // reads the latest runAction through a ref.
  const runRef = useRef(runAction)
  runRef.current = runAction
  const paletteRef = useRef(palette)
  paletteRef.current = palette
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const hit = resolveAppShortcut(ev, window.qclod.platform)
      if (!hit) return
      // Always ours, so no default (Close Window, Reload…) sees the key.
      ev.preventDefault()
      // A held Ctrl+R must not reload again and again.
      if (hit.id === 'reload' && ev.repeat) return
      // With the palette open only Ctrl+K (to close it) and Ctrl+H (its history) run.
      if (paletteRef.current && hit.id !== 'actions' && hit.id !== 'history') return
      runRef.current(hit.id, hit.index)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Voice into the input (этап 5): Ctrl+Space in this window only; the menu's «Настройки голоса» opens «Голос».
  useVoiceHotkey({
    openSettings: () => {
      setSettingsSection('voice')
      setSettingsOpen(true)
    },
    focusField: focusComposer
  })
  // The Mac menu's «Настройки…» does what the key does.
  useEffect(() => window.qclod.onAppAction((id) => runRef.current(id)), [])

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
  /** Why a tab's ribbon could not be read, by tab; the pane shows it with «Повторить». */
  const [ribbonErrors, setRibbonErrors] = useState<Record<string, string>>({})
  const loadRibbon = useCallback(
    (id: string): void => {
      if (ribbonsAsked.current.has(id)) return
      ribbonsAsked.current.add(id)
      window.qclod.ribbon(id).then(
        (snapshot) => {
          setRibbon(id, snapshot)
          setRibbonErrors((all) => without(all, id))
        },
        (err) => setRibbonErrors((all) => ({ ...all, [id]: reasonOf(err) }))
      )
    },
    [setRibbon]
  )
  /** «Повторить» asks for the same ribbon again; the button goes, so focus goes to the input. */
  const retryRibbon = useCallback(
    (id: string): void => {
      setRibbonErrors((all) => without(all, id))
      ribbonsAsked.current.delete(id)
      loadRibbon(id)
      focusComposer()
    },
    [loadRibbon, focusComposer]
  )

  // On mount and on every switch, for both panes — as the panel is.
  useEffect(() => {
    if (activeTabId) loadRibbon(activeTabId)
  }, [activeTabId, loadRibbon])
  useEffect(() => {
    for (const id of paneTabIds) loadRibbon(id)
  }, [paneTabIds, loadRibbon])

  if (environment && setupNeeded && !setupDismissed) {
    // Settings open over the setup screen; closing them checks again, since
    // the agent path is what they were opened for.
    return (
      <>
        <SetupTitleBar />
        <SetupScreen
          report={environment}
          checking={checking}
          checkError={checkError}
          onRecheck={recheck}
          onDone={() => setSetupDismissed(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {settingsOpen && (
          <SettingsScreen
            settings={settings}
            loadError={settingsError}
            onRetryLoad={loadSettings}
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
        chatTitle={split ? null : (tabs.find((t) => t.id === activeTabId)?.title ?? null)}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        hotkey={hotkey}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleSplit={toggleSplit}
        splitOpen={split}
      />
      <UpdateBanner />
      <div className={`app-body${split ? ' app-split' : ''}`}>
        {sidebarOpen && (
          <Sidebar
            projects={sidebar}
            activeTabId={activeTabId}
            paneTabIds={paneTabIds}
            onActivate={activate}
            onClose={(id) => {
              clearCloseGuard()
              closeChat(id)
            }}
            onNewChat={newChat}
            onOpenPast={openPast}
            onToggleProject={toggleProject}
            onForget={(cwd) => void window.qclod.forgetProject(cwd)}
            onRetryPast={(cwd) => loadProjectHistory(cwd)}
          />
        )}
        <SplitView
          panes={paneTabIds.length > 0 ? paneTabIds : [activeTabId]}
          widths={paneWidths}
          activeTabId={activeTabId}
          renderPane={(id, index) => (
            <ErrorBoundary scope="pane">
              {__QCLOD_TEST_SEAMS__ && split && index === 0 && <ThrowInPane />}
              <ChatPane
                tabId={id}
                focused={id === activeTabId}
                focusToken={focusToken}
                title={tabs.find((t) => t.id === id)?.title ?? ''}
                split={split}
                onUnsplit={() => applyPanes(shownPanes().filter((pane) => pane !== id))}
                // Clicking a pane makes it the one everything acts on, in place.
                onFocus={() => focusPane(id)}
                onCycleMode={cycleMode}
                onOpenHistory={() => togglePalette('history')}
                onOpenSession={openSession}
                panelRequest={panelRequest}
                ribbonError={ribbonErrors[id] ?? null}
                onRetryRibbon={() => retryRibbon(id)}
                notice={
                  id === activeTabId && closeGuardTab === activeTabId
                    ? { testId: 'close-guard', text: `Агент работает — ${actionKeys('closeTab')} ещё раз закроет чат` }
                    : null
                }
              />
            </ErrorBoundary>
          )}
          onDrop={dropOnSplit}
          onResize={setPaneWidths}
          onFocus={focusPane}
        />
      </div>
      {palette && paletteCtx && (
        <CommandPalette
          key={palette.n}
          ctx={paletteCtx}
          {...(palette.scope === undefined ? {} : { initialScope: palette.scope })}
          onClose={() => setPalette(null)}
          onFocusLost={focusComposer}
        />
      )}
      {settingsOpen && (
        <SettingsScreen
          settings={settings}
          loadError={settingsError}
          onRetryLoad={loadSettings}
          version={version}
          models={(activeTabId ? panelByTab[activeTabId]?.models : undefined) ?? []}
          onPatch={async (patch) => {
            const next = await window.qclod.setSettings(patch)
            setSettings(next)
            return next
          }}
          {...(settingsSection !== undefined ? { initialSection: settingsSection } : {})}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsSection(undefined)
          }}
          onFocusLost={focusComposer}
        />
      )}
    </div>
  )
}
