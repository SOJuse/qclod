import { create } from 'zustand'
import type { AppSettings, TabId, TabState } from '../../shared/types'

export type FocusTarget = 'composer' | 'terminal'

interface AppState {
  settings: AppSettings | null
  focusTarget: FocusTarget
  activeTabId: TabId
  tabs: TabState[]
  /** Unsent text per tab — switching tabs or focus must never lose it. */
  draftByTab: Record<TabId, string>
  /** When the composer last received a keystroke (epoch ms). */
  lastTypedAt: number
  /** The agent is showing an arrow-driven menu, per tab. */
  menuActiveByTab: Record<TabId, boolean>

  setSettings: (settings: AppSettings) => void
  patchSettings: (patch: Partial<AppSettings>) => void
  setFocusTarget: (target: FocusTarget) => void
  toggleFocusTarget: () => void
  setActiveTabId: (id: TabId) => void
  setTabs: (tabs: TabState[]) => void
  setDraft: (id: TabId, text: string) => void
  setMenuActive: (id: TabId, active: boolean) => void
  markTyped: () => void
  markHandedOff: () => void
}

export const useAppStore = create<AppState>((set) => ({
  settings: null,
  focusTarget: 'composer',
  activeTabId: '',
  tabs: [],
  draftByTab: {},
  menuActiveByTab: {},
  lastTypedAt: 0,

  setSettings: (settings) => set({ settings }),
  patchSettings: (patch) =>
    set((state) => (state.settings ? { settings: { ...state.settings, ...patch } } : state)),
  setFocusTarget: (focusTarget) => set({ focusTarget }),
  toggleFocusTarget: () =>
    set((state) => ({ focusTarget: state.focusTarget === 'composer' ? 'terminal' : 'composer' })),
  setActiveTabId: (activeTabId) => set({ activeTabId }),
  setTabs: (tabs) =>
    set((state) => ({
      tabs,
      // Keep a valid selection if the active tab went away.
      activeTabId: tabs.some((t) => t.id === state.activeTabId)
        ? state.activeTabId
        : (tabs[0]?.id ?? '')
    })),
  setDraft: (id, text) => set((state) => ({ draftByTab: { ...state.draftByTab, [id]: text } })),
  markTyped: () => set({ lastTypedAt: Date.now() }),
  // Submitting is an explicit hand-off: a menu that follows was asked for.
  markHandedOff: () => set({ lastTypedAt: 0 }),
  setMenuActive: (id, active) =>
    set((state) => ({ menuActiveByTab: { ...state.menuActiveByTab, [id]: active } }))
}))
