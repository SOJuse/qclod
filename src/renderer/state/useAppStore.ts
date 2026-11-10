import { create } from 'zustand'
import type { PendingAttachment } from '../input/attachments'
import type {
  AppSettings,
  PanelData,
  PanelSnapshot,
  RibbonChange,
  RibbonItem,
  TabId,
  TabState,
  TodoItem
} from '../../shared/types'

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
  ribbonByTab: Record<TabId, RibbonItem[]>
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

  setSettings: (settings: AppSettings) => void
  patchSettings: (patch: Partial<AppSettings>) => void
  setActiveTabId: (id: TabId) => void
  setSplitTabId: (id: TabId | null) => void
  setTabs: (tabs: TabState[]) => void
  setRibbon: (id: TabId, items: RibbonItem[]) => void
  applyRibbon: (id: TabId, changes: RibbonChange[]) => void
  applyPanel: (id: TabId, patch: Partial<PanelData>, rev: number) => void
  setPanelSnapshot: (id: TabId, snapshot: PanelSnapshot) => void
  setDraft: (id: TabId, text: string) => void
  setAttachments: (id: TabId, items: PendingAttachment[]) => void
  setFileIndex: (id: TabId, paths: string[]) => void
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

  for (const change of changes) {
    if (change.kind === 'append') {
      ensureCopy()
      next.push(change.item)
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
  ribbonByTab: {},
  todoByTab: {},
  panelByTab: {},
  panelRevByTab: {},
  busySinceByTab: {},
  draftByTab: {},
  attachmentsByTab: {},
  fileIndexByTab: {},

  setSettings: (settings) => set({ settings }),
  patchSettings: (patch) =>
    set((state) => (state.settings ? { settings: { ...state.settings, ...patch } } : state)),
  setActiveTabId: (activeTabId) => set({ activeTabId }),
  setSplitTabId: (splitTabId) => set({ splitTabId }),

  setTabs: (tabs) =>
    set((state) => ({
      tabs,
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

  setRibbon: (id, items) => set((state) => ({ ribbonByTab: { ...state.ribbonByTab, [id]: items } })),

  applyRibbon: (id, changes) =>
    set((state) => {
      const { items, todo } = reduceRibbon(state.ribbonByTab[id] ?? [], changes)
      return {
        ribbonByTab: { ...state.ribbonByTab, [id]: items },
        ...(todo ? { todoByTab: { ...state.todoByTab, [id]: todo } } : {})
      }
    }),

  applyPanel: (id, patch, rev) =>
    set((state) => ({
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
      if (snapshot.rev < (state.panelRevByTab[id] ?? -1)) return state
      return {
        panelByTab: { ...state.panelByTab, [id]: snapshot.data },
        panelRevByTab: { ...state.panelRevByTab, [id]: snapshot.rev }
      }
    }),

  setDraft: (id, text) => set((state) => ({ draftByTab: { ...state.draftByTab, [id]: text } })),

  setAttachments: (id, items) =>
    set((state) => ({ attachmentsByTab: { ...state.attachmentsByTab, [id]: items } })),

  setFileIndex: (id, paths) =>
    set((state) => ({ fileIndexByTab: { ...state.fileIndexByTab, [id]: paths } }))

}))
