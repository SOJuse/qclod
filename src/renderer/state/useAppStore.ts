import { create } from 'zustand'
import type {
  AppSettings,
  PanelData,
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
  permissionMode: 'default',
  mcp: [],
  projectSettings: null
})

interface AppState {
  settings: AppSettings | null
  activeTabId: TabId
  tabs: TabState[]
  ribbonByTab: Record<TabId, RibbonItem[]>
  todoByTab: Record<TabId, TodoItem[]>
  panelByTab: Record<TabId, PanelData>
  /** Unsent text per tab — switching tabs must never lose it. */
  draftByTab: Record<TabId, string>

  setSettings: (settings: AppSettings) => void
  patchSettings: (patch: Partial<AppSettings>) => void
  setActiveTabId: (id: TabId) => void
  setTabs: (tabs: TabState[]) => void
  setRibbon: (id: TabId, items: RibbonItem[]) => void
  applyRibbon: (id: TabId, changes: RibbonChange[]) => void
  applyPanel: (id: TabId, patch: Partial<PanelData>) => void
  setDraft: (id: TabId, text: string) => void
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
  tabs: [],
  ribbonByTab: {},
  todoByTab: {},
  panelByTab: {},
  draftByTab: {},

  setSettings: (settings) => set({ settings }),
  patchSettings: (patch) =>
    set((state) => (state.settings ? { settings: { ...state.settings, ...patch } } : state)),
  setActiveTabId: (activeTabId) => set({ activeTabId }),

  setTabs: (tabs) =>
    set((state) => ({
      tabs,
      // Keep a valid selection if the active tab went away.
      activeTabId: tabs.some((t) => t.id === state.activeTabId)
        ? state.activeTabId
        : (tabs[0]?.id ?? '')
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

  applyPanel: (id, patch) =>
    set((state) => ({
      panelByTab: {
        ...state.panelByTab,
        [id]: { ...(state.panelByTab[id] ?? EMPTY_PANEL), ...patch }
      }
    })),

  setDraft: (id, text) => set((state) => ({ draftByTab: { ...state.draftByTab, [id]: text } }))

}))
