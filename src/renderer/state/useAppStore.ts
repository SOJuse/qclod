import { create } from 'zustand'
import type { AppSettings, TabId } from '../../shared/types'

export type FocusTarget = 'composer' | 'terminal'

interface AppState {
  settings: AppSettings | null
  focusTarget: FocusTarget
  activeTabId: TabId
  /** Unsent text per tab — switching tabs or focus must never lose it. */
  draftByTab: Record<TabId, string>
  /** The agent is showing an arrow-driven menu, per tab. */
  menuActiveByTab: Record<TabId, boolean>

  setSettings: (settings: AppSettings) => void
  patchSettings: (patch: Partial<AppSettings>) => void
  setFocusTarget: (target: FocusTarget) => void
  toggleFocusTarget: () => void
  setActiveTabId: (id: TabId) => void
  setDraft: (id: TabId, text: string) => void
  setMenuActive: (id: TabId, active: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  settings: null,
  focusTarget: 'composer',
  activeTabId: 'default',
  draftByTab: {},
  menuActiveByTab: {},

  setSettings: (settings) => set({ settings }),
  patchSettings: (patch) =>
    set((state) => (state.settings ? { settings: { ...state.settings, ...patch } } : state)),
  setFocusTarget: (focusTarget) => set({ focusTarget }),
  toggleFocusTarget: () =>
    set((state) => ({ focusTarget: state.focusTarget === 'composer' ? 'terminal' : 'composer' })),
  setActiveTabId: (activeTabId) => set({ activeTabId }),
  setDraft: (id, text) => set((state) => ({ draftByTab: { ...state.draftByTab, [id]: text } })),
  setMenuActive: (id, active) =>
    set((state) => ({ menuActiveByTab: { ...state.menuActiveByTab, [id]: active } }))
}))
