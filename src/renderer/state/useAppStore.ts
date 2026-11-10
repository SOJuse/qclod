import { create } from 'zustand'
import type { PendingAttachment } from '../input/attachments'
import type {
  AppSettings,
  CommandInfo,
  PanelData,
  PanelSnapshot,
  ResolvedPath,
  RibbonChange,
  RibbonItem,
  RibbonSnapshot,
  TabId,
  TabState,
  TodoItem
} from '../../shared/types'

const PER_TAB_KEYS = [
  'ribbonByTab',
  'ribbonRevByTab',
  'todoByTab',
  'panelByTab',
  'panelRevByTab',
  'draftByTab',
  'attachmentsByTab',
  'fileIndexByTab',
  'commandsByTab',
  'pathsByTab'
] as const

const RECENT_COMMANDS = 6
/** Answers about paths kept per tab; the oldest go first past this. */
const PATHS_PER_TAB = 5000

function closedAfter(state: AppState, tabs: TabState[]): ReadonlySet<TabId> {
  const open = new Set(tabs.map((t) => t.id))
  const closed = new Set(state.closedTabs)
  for (const t of state.tabs) if (!open.has(t.id)) closed.add(t.id)
  for (const id of open) closed.delete(id)
  return closed
}

function forgetClosed(state: AppState, tabs: TabState[]): Partial<AppState> {
  const open = new Set(tabs.map((t) => t.id))
  const closed = state.tabs.filter((t) => !open.has(t.id)).map((t) => t.id)
  if (closed.length === 0) return {}
  const next: Record<string, unknown> = {}
  for (const key of PER_TAB_KEYS) {
    next[key] = Object.fromEntries(Object.entries(state[key]).filter(([id]) => !closed.includes(id)))
  }
  return next as Partial<AppState>
}

export const EMPTY_PANEL: PanelData = Object.freeze({
  context: null,
  cost: null,
  limits: { fiveHour: null, sevenDay: null },
  model: null,
  models: [],
  effort: null,
  permissionMode: 'default',
  mcp: [],
  projectSettings: null
})

interface AppState {
  settings: AppSettings | null
  activeTabId: TabId
  /** The conversation shown beside the active one, when the view is split. */
  splitTabId: TabId | null
  tabs: TabState[]
  /** Ids of tabs that were closed: late events and answers for them are dropped. */
  closedTabs: ReadonlySet<TabId>
  ribbonByTab: Record<TabId, RibbonItem[]>
  /** The newest ribbon revision applied per tab — anything not newer is already in. */
  ribbonRevByTab: Record<TabId, number>
  todoByTab: Record<TabId, TodoItem[]>
  panelByTab: Record<TabId, PanelData>
  /** The newest panel revision applied per tab — a snapshot older than it is stale. */
  panelRevByTab: Record<TabId, number>
  /** When the current turn started, per tab — epoch ms. */
  busySinceByTab: Record<TabId, number>
  /** Unsent text and files per tab — switching tabs must never lose them. */
  draftByTab: Record<TabId, string>
  attachmentsByTab: Record<TabId, PendingAttachment[]>
  fileIndexByTab: Record<TabId, string[]>
  /** What each session offers after `/`; absent until first asked for. */
  commandsByTab: Record<TabId, CommandInfo[]>
  /**
   * What main said about each path text a tab showed: where it is, or null
   * for "not on disk" — so the same text is never asked about twice.
   */
  pathsByTab: Record<TabId, ReadonlyMap<string, ResolvedPath | null>>
  /** The last commands run, newest first — they head the list before anything is typed. */
  recentCommands: string[]

  setSettings: (settings: AppSettings) => void
  patchSettings: (patch: Partial<AppSettings>) => void
  setActiveTabId: (id: TabId) => void
  setSplitTabId: (id: TabId | null) => void
  setTabs: (tabs: TabState[]) => void
  setRibbon: (id: TabId, snapshot: RibbonSnapshot) => void
  applyRibbon: (id: TabId, changes: RibbonChange[], rev: number) => void
  applyPanel: (id: TabId, patch: Partial<PanelData>, rev: number) => void
  setPanelSnapshot: (id: TabId, snapshot: PanelSnapshot) => void
  setDraft: (id: TabId, text: string) => void
  setAttachments: (id: TabId, items: PendingAttachment[]) => void
  setFileIndex: (id: TabId, paths: string[]) => void
  setCommands: (id: TabId, commands: CommandInfo[]) => void
  setPaths: (id: TabId, answers: ReadonlyArray<readonly [string, ResolvedPath | null]>) => void
  noteCommand: (name: string) => void
}

/** Applies one batch of changes to one tab's ribbon, without mutating in place. */
export function reduceRibbon(
  items: RibbonItem[],
  changes: RibbonChange[]
): { items: RibbonItem[]; todo: TodoItem[] | null } {
  let next = items
  let todo: TodoItem[] | null = null
  let copied = false

  const ensureCopy = (): void => {
    if (!copied) {
      next = [...next]
      copied = true
    }
  }
  // Where each id sits, built once per batch: a replayed session arrives as
  // thousands of appends in one batch, and a scan per append would be quadratic.
  let positions: Map<string, number> | null = null
  const positionOf = (id: string): number => {
    positions ??= new Map(next.map((item, i) => [item.id, i]))
    return positions.get(id) ?? -1
  }

  for (const change of changes) {
    if (change.kind === 'append') {
      ensureCopy()
      // A second safety net behind the revisions: the same item twice is
      // the newer copy of it, never a second bubble.
      const at = positionOf(change.item.id)
      if (at === -1) positions!.set(change.item.id, next.push(change.item) - 1)
      else next[at] = change.item
    } else if (change.kind === 'update') {
      const at = next.findIndex((item) => item.id === change.id)
      if (at === -1) continue
      ensureCopy()
      next[at] = { ...next[at], ...change.patch } as RibbonItem
    } else {
      todo = change.items
    }
  }

  return { items: next, todo }
}

export const useAppStore = create<AppState>((set) => ({
  settings: null,
  activeTabId: '',
  splitTabId: null,
  tabs: [],
  closedTabs: new Set(),
  ribbonByTab: {},
  ribbonRevByTab: {},
  todoByTab: {},
  panelByTab: {},
  panelRevByTab: {},
  busySinceByTab: {},
  draftByTab: {},
  attachmentsByTab: {},
  fileIndexByTab: {},
  commandsByTab: {},
  pathsByTab: {},
  recentCommands: [],

  setSettings: (settings) => set({ settings }),
  patchSettings: (patch) =>
    set((state) => (state.settings ? { settings: { ...state.settings, ...patch } } : state)),
  setActiveTabId: (activeTabId) => set({ activeTabId }),
  setSplitTabId: (splitTabId) => set({ splitTabId }),

  setTabs: (tabs) =>
    set((state) => ({
      tabs,
      // A closed tab's data goes with it. Only tabs this store has seen in
      // `tabs` are forgotten: a new tab's ribbon events can precede the list.
      ...forgetClosed(state, tabs),
      closedTabs: closedAfter(state, tabs),
      busySinceByTab: tabs.reduce<Record<TabId, number>>((acc, tab) => {
        const working = tab.status === 'busy' || tab.status === 'waiting'
        const previous = state.tabs.find((t) => t.id === tab.id)
        const wasWorking = previous?.status === 'busy' || previous?.status === 'waiting'
        if (working) acc[tab.id] = wasWorking ? (state.busySinceByTab[tab.id] ?? Date.now()) : Date.now()
        return acc
      }, {}),
      // Keep a valid selection if the active tab went away.
      activeTabId: tabs.some((t) => t.id === state.activeTabId)
        ? state.activeTabId
        : (tabs[0]?.id ?? ''),
      // A pane whose tab was closed stops being a pane.
      splitTabId: tabs.some((t) => t.id === state.splitTabId) ? state.splitTabId : null
    })),

  // The snapshot is the whole ribbon at its revision: it replaces whatever
  // the window holds unless that is already newer. Events it already holds
  // arrive later with a revision no newer than it, and are dropped.
  setRibbon: (id, snapshot) =>
    set((state) => {
      if (state.closedTabs.has(id) || snapshot.rev < (state.ribbonRevByTab[id] ?? -1)) return state
      return {
        ribbonByTab: { ...state.ribbonByTab, [id]: snapshot.items },
        ribbonRevByTab: { ...state.ribbonRevByTab, [id]: snapshot.rev },
        ...(snapshot.todo ? { todoByTab: { ...state.todoByTab, [id]: snapshot.todo } } : {})
      }
    }),

  applyRibbon: (id, changes, rev) =>
    set((state) => {
      if (state.closedTabs.has(id) || rev <= (state.ribbonRevByTab[id] ?? -1)) return state
      const { items, todo } = reduceRibbon(state.ribbonByTab[id] ?? [], changes)
      return {
        ribbonByTab: { ...state.ribbonByTab, [id]: items },
        ribbonRevByTab: { ...state.ribbonRevByTab, [id]: rev },
        ...(todo ? { todoByTab: { ...state.todoByTab, [id]: todo } } : {})
      }
    }),

  applyPanel: (id, patch, rev) =>
    set((state) => state.closedTabs.has(id) ? state : ({
      panelByTab: {
        ...state.panelByTab,
        [id]: { ...(state.panelByTab[id] ?? EMPTY_PANEL), ...patch }
      },
      panelRevByTab: {
        ...state.panelRevByTab,
        [id]: Math.max(rev, state.panelRevByTab[id] ?? -1)
      }
    })),

  // The snapshot is taken when it is asked for and lands when it returns;
  // events that arrived in between are newer than it and must survive — the
  // same race the ribbon had on tab switches.
  setPanelSnapshot: (id, snapshot) =>
    set((state) => {
      if (state.closedTabs.has(id) || snapshot.rev < (state.panelRevByTab[id] ?? -1)) return state
      return {
        panelByTab: { ...state.panelByTab, [id]: snapshot.data },
        panelRevByTab: { ...state.panelRevByTab, [id]: snapshot.rev }
      }
    }),

  setDraft: (id, text) => set((state) => (state.closedTabs.has(id) ? state : { draftByTab: { ...state.draftByTab, [id]: text } })),

  setAttachments: (id, items) =>
    set((state) => (state.closedTabs.has(id) ? state : { attachmentsByTab: { ...state.attachmentsByTab, [id]: items } })),

  setFileIndex: (id, paths) =>
    set((state) => (state.closedTabs.has(id) ? state : { fileIndexByTab: { ...state.fileIndexByTab, [id]: paths } })),

  setCommands: (id, commands) =>
    set((state) => (state.closedTabs.has(id) ? state : { commandsByTab: { ...state.commandsByTab, [id]: commands } })),

  setPaths: (id, answers) =>
    set((state) => {
      if (state.closedTabs.has(id) || answers.length === 0) return state
      const next = new Map(state.pathsByTab[id])
      for (const [raw, answer] of answers) next.set(raw, answer)
      // A Map iterates in insertion order: the first keys are the oldest.
      for (const raw of next.keys()) {
        if (next.size <= PATHS_PER_TAB) break
        next.delete(raw)
      }
      return { pathsByTab: { ...state.pathsByTab, [id]: next } }
    }),

  noteCommand: (name) =>
    set((state) => ({
      recentCommands: [name, ...state.recentCommands.filter((n) => n !== name)].slice(0, RECENT_COMMANDS)
    }))

}))
