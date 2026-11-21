import { create } from 'zustand'
import type { PendingAttachment } from '../input/attachments'
import { UI_KEY, loadUi, serializeUi } from './uiPersist'
import { startHeldDrafts } from './heldDrafts'
import { MAX_PANES, nextPanes, type ProjectHistory } from '../chat/sidebarModel'
import { projectKey } from '../../shared/projects'
import { DEFAULT_LAYOUT, NO_AUTONOMY, type LayoutState } from '../../shared/types'
import type { PanelOverride } from '../app/panelVisibility'
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
  'pathsByTab',
  'layerByTab',
  'panelChoiceByTab'
] as const

/** How the agents layer shows a chat's subagents (этап 4). */
export type AgentsView = 'graph' | 'timeline'

const RECENT_COMMANDS = 6
/** Answers about paths kept per tab; the oldest go first past this. */
const PATHS_PER_TAB = 5000
/**
 * How long "no such file" holds. Agents name a file before they create it,
 * so a "no" is only a recent fact; a "yes" holds (an action re-checks it).
 */
export const MISSING_TTL_MS = 10_000
/** Tools whose result may have made a file that was not there before. */
const WRITING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash'])

/** What main said about one path text, and when. */
export interface PathAnswer {
  target: ResolvedPath | null
  at: number
}

/** Whether an answer still stands, so the text need not be asked about again. */
export function pathSettled(answer: PathAnswer | undefined, now = Date.now()): boolean {
  if (!answer) return false
  return answer.target !== null || now - answer.at < MISSING_TTL_MS
}

/** Whether these changes finish a call that writes files (in its result or its error). */
function finishesWrite(items: RibbonItem[], changes: RibbonChange[]): boolean {
  const ids = new Set<string>()
  for (const change of changes) {
    if (change.kind === 'append') ids.add(change.item.id)
    else if (change.kind === 'update') ids.add(change.id)
  }
  if (ids.size === 0) return false
  return items.some(
    (item) =>
      ids.has(item.id) &&
      ((item.kind === 'tool' && item.state !== 'running') || item.kind === 'toolError') &&
      WRITING_TOOLS.has(item.name)
  )
}

/** A tab's answers without its "no"s: after a write they may be wrong. */
function withoutMissing(
  known: ReadonlyMap<string, PathAnswer> | undefined
): ReadonlyMap<string, PathAnswer> | undefined {
  if (!known || ![...known.values()].some((a) => a.target === null)) return known
  return new Map([...known].filter(([, a]) => a.target !== null))
}

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
  // The first list after a reload: what the window restored for tabs that are gone is stale.
  if (state.tabs.length === 0) {
    for (const id of [...Object.keys(state.draftByTab), ...Object.keys(state.attachmentsByTab)]) {
      if (!open.has(id)) closed.push(id)
    }
  }
  if (closed.length === 0) return {}
  const next: Record<string, unknown> = {}
  for (const key of PER_TAB_KEYS) {
    next[key] = Object.fromEntries(Object.entries(state[key]).filter(([id]) => !closed.includes(id)))
  }
  return next as Partial<AppState>
}

export { MAX_PANES }

/** What a pane can lay over its ribbon: subagents (этап 4), a file (этап 6), git (этап 7). */
export type PaneLayerKind = 'agents' | 'git' | 'file'

/** One layer over a pane's ribbon. agentId — этап 4; path, line — этапы 6, 7. */
export interface PaneLayerState {
  kind: PaneLayerKind
  agentId?: string
  path?: string
  line?: number
}

/**
 * The panes and the active tab once the tab list changed (or main's layout
 * came): a pane whose tab was closed stops being a pane, and the active one
 * is replaced by its neighbour. `want` is the layout to fit instead of the
 * window's own panes, and `was` the chat that was active there before. An
 * active chat that is not a pane takes the slot of the chat that was active
 * before it, so no other pane is pushed out.
 */
function paneStateAfter(
  state: Pick<AppState, 'paneTabIds' | 'activeTabId'>,
  tabs: TabState[],
  want?: { panes: TabId[]; active: TabId | null; was?: TabId }
): { paneTabIds: TabId[]; activeTabId: TabId } {
  const alive = (id: TabId): boolean => tabs.some((t) => t.id === id)
  const source = want?.panes ?? state.paneTabIds
  // Cut to the row first: an active chat past the fourth then takes a slot instead of falling off.
  const paneTabIds = [...new Set(source)].filter(alive).slice(0, MAX_PANES)
  let activeTabId = want?.active ?? state.activeTabId
  if (!alive(activeTabId)) {
    const was = source.indexOf(activeTabId)
    const near = was === -1 ? paneTabIds[0] : paneTabIds[Math.min(was, paneTabIds.length - 1)]
    activeTabId = near ?? tabs[0]?.id ?? ''
  }
  if (activeTabId && !paneTabIds.includes(activeTabId)) {
    const slot = paneTabIds.indexOf(want?.was ?? state.activeTabId)
    if (paneTabIds.length === 0) paneTabIds.push(activeTabId)
    else if (slot !== -1 || paneTabIds.length >= MAX_PANES) paneTabIds[Math.max(0, slot)] = activeTabId
    else paneTabIds.unshift(activeTabId)
  }
  // The same panes keep the same array: effects and storage writes key on it.
  const same =
    paneTabIds.length === state.paneTabIds.length && paneTabIds.every((id, i) => id === state.paneTabIds[i])
  return { paneTabIds: same ? state.paneTabIds : paneTabIds, activeTabId }
}

/**
 * Whether this list brings chats that main's saved panes name and the earlier
 * list did not hold, while the window's panes are still just what that earlier
 * list let through: then the saved panes are laid over again, so a split that
 * arrives in several pushes is not cut down.
 */
function savedPanesArrived(state: AppState, tabs: TabState[]): boolean {
  const had = new Set(state.tabs.map((t) => t.id))
  const has = new Set(tabs.map((t) => t.id))
  const saved = state.layout.panes
  if (!saved.some((id) => has.has(id) && !had.has(id))) return false
  const then = saved.filter((id) => had.has(id))
  return then.length === state.paneTabIds.length && then.every((id, i) => id === state.paneTabIds[i])
}

/** Main's layout laid over the tabs the window knows. */
function applyLayout(
  state: AppState,
  layout: LayoutState,
  tabs: TabState[],
  was?: TabId
): Pick<AppState, 'paneTabIds' | 'activeTabId' | 'paneWidths' | 'layoutPending'> {
  const fit = paneStateAfter(state, tabs, { panes: layout.panes, active: layout.active, ...(was ? { was } : {}) })
  const widths = layout.paneWidths.length === fit.paneTabIds.length ? layout.paneWidths : []
  const sameWidths = widths.length === state.paneWidths.length && widths.every((w, i) => w === state.paneWidths[i])
  return { ...fit, paneWidths: sameWidths ? state.paneWidths : widths, layoutPending: false }
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
  projectSettings: null,
  queue: [],
  backgroundTasks: [],
  autonomy: NO_AUTONOMY,
  costRates: null
})

interface AppState {
  settings: AppSettings | null
  activeTabId: TabId
  /** The panes left to right; one of them is always the active tab. [] while there are no tabs. */
  paneTabIds: TabId[]
  /** Shares of the row, one per pane; [] means equal. Main's, via the layout. */
  paneWidths: number[]
  /** The layout as main last said it: panes, active and widths are applied from it, the rest is read from it. */
  layout: LayoutState
  /** The layout came before any tab did; the first list lays it over them. */
  layoutPending: boolean
  /** The past conversations per project, by projectKey. */
  historyByProject: Record<string, ProjectHistory>
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
  pathsByTab: Record<TabId, ReadonlyMap<string, PathAnswer>>
  /** The last commands run, newest first — they head the list before anything is typed. */
  recentCommands: string[]
  /** The one layer each pane shows over its ribbon (сверка F9); in memory only, never saved. */
  layerByTab: Record<TabId, PaneLayerState | null>
  /** Each pane's own panel choice (S2-R23): open or closed by hand; absent — the setting decides. In memory only. */
  panelChoiceByTab: Record<TabId, PanelOverride>
  /** этап 4: graph or timeline in every agents layer; survives a reload of the window (uiPersist), not a restart. */
  agentsView: AgentsView
  /** этап 4: what is typed to a subagent, by `${tabId}:${cardId}`; in memory only. */
  agentDrafts: Record<string, string>

  setSettings: (settings: AppSettings) => void
  patchSettings: (patch: Partial<AppSettings>) => void
  setActiveTabId: (id: TabId) => void
  /** Sets the panes: no duplicates or closed tabs, at most MAX_PANES. */
  setPanes: (ids: TabId[]) => void
  /** Makes a pane the active one without moving any pane. */
  focusPane: (id: TabId) => void
  /** Takes main's layout: panes, active and widths at once if the tabs are known, otherwise with the list. */
  setLayout: (layout: LayoutState) => void
  setPaneWidths: (widths: number[]) => void
  /** Asks main for a folder's past conversations; once, unless forced. */
  loadProjectHistory: (cwd: string, force?: boolean) => void
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
  /** A new layer replaces the one before it; null closes it. */
  setPaneLayer: (tabId: TabId, layer: PaneLayerState | null) => void
  setPanelChoice: (tabId: TabId, choice: PanelOverride) => void
  /** этап 4: the agents layer over this pane's ribbon; with `agentId` (a card id) — that subagent's own ribbon. */
  openAgents: (tabId: TabId, agentId?: string | null) => void
  closeAgents: (tabId: TabId) => void
  setAgentsView: (view: AgentsView) => void
  setAgentDraft: (key: string, text: string) => void
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

function ui(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** The history reads under way, by projectKey; `again` — a forced read was asked for meanwhile. */
const historyReads = new Map<string, { again: boolean }>()

/** What the window held before it was reloaded; a tab that is gone is dropped by setTabs. */
const restored = loadUi(ui())
/** After the watchdog's reload a long draft is held back, not put into the field (heldDrafts.ts). */
const restoredDrafts = startHeldDrafts(restored.draftByTab, ui())

export const useAppStore = create<AppState>((set, get) => ({
  settings: null,
  activeTabId: '',
  paneTabIds: [],
  paneWidths: [],
  layout: { ...DEFAULT_LAYOUT, panes: [], paneWidths: [], projects: [] },
  layoutPending: false,
  historyByProject: {},
  tabs: [],
  closedTabs: new Set(),
  ribbonByTab: {},
  ribbonRevByTab: {},
  todoByTab: {},
  panelByTab: {},
  panelRevByTab: {},
  busySinceByTab: {},
  draftByTab: restoredDrafts,
  attachmentsByTab: restored.attachmentsByTab,
  fileIndexByTab: {},
  commandsByTab: {},
  pathsByTab: {},
  recentCommands: [],
  layerByTab: {},
  panelChoiceByTab: {},
  agentsView: restored.agentsView ?? 'graph',
  agentDrafts: {},

  setSettings: (settings) => set({ settings }),
  patchSettings: (patch) =>
    set((state) => (state.settings ? { settings: { ...state.settings, ...patch } } : state)),
  setActiveTabId: (activeTabId) =>
    set((state) => {
      // A late word about a chat already closed changes nothing.
      if (state.closedTabs.has(activeTabId)) return state
      // A tab from outside the panes takes the place of the active pane.
      if (state.paneTabIds.length === 0 || state.paneTabIds.includes(activeTabId)) return { activeTabId }
      const at = Math.max(0, state.paneTabIds.indexOf(state.activeTabId))
      return { activeTabId, paneTabIds: state.paneTabIds.map((id, i) => (i === at ? activeTabId : id)) }
    }),
  setPanes: (ids) =>
    set((state) => {
      const open = ids.filter((id) => !state.closedTabs.has(id))
      // An empty row is never asked for: the active chat stays its one pane.
      const keep = open.length === 0 && state.tabs.some((t) => t.id === state.activeTabId) ? [state.activeTabId] : open
      const next = nextPanes(state, keep)
      const same =
        next.paneTabIds.length === state.paneTabIds.length && next.paneTabIds.every((id, i) => id === state.paneTabIds[i])
      return {
        paneTabIds: same ? state.paneTabIds : next.paneTabIds,
        activeTabId: next.activeTabId,
        // The shares belong to the panes they were made for.
        ...(next.paneTabIds.length === state.paneWidths.length ? {} : { paneWidths: [] })
      }
    }),
  focusPane: (id) => set((state) => (state.paneTabIds.includes(id) ? { activeTabId: id } : state)),

  setLayout: (layout) =>
    set((state) =>
      state.tabs.length === 0
        ? { layout, layoutPending: true }
        : layout.active !== null && !state.tabs.some((t) => t.id === layout.active)
          ? // Main made a chat active that the list does not hold yet: its own activation and the list follow.
            { layout }
          : // The new active chat takes the slot of the one main had active, as main's panes know it.
            { layout, ...applyLayout(state, layout, state.tabs, state.layout.active ?? undefined) }
    ),
  setPaneWidths: (paneWidths) => set({ paneWidths }),

  loadProjectHistory: (cwd, force = false) => {
    const key = projectKey(cwd)
    const running = historyReads.get(key)
    if (running) {
      // The answer on its way may predate what changed (a chat closed meanwhile): one more read follows it.
      if (force) running.again = true
      return
    }
    const known = get().historyByProject[key]
    const list = known !== undefined && known !== 'loading' && known.error === undefined ? known : null
    if (list && !force) return
    const read = { again: false }
    historyReads.set(key, read)
    // A list already shown stays while it is read again (S2-R18).
    set((state) => ({
      historyByProject: { ...state.historyByProject, [key]: list ? { items: list.items, reading: true } : 'loading' }
    }))
    const done = (entry: ProjectHistory): void => {
      historyReads.delete(key)
      set((state) => ({ historyByProject: { ...state.historyByProject, [key]: entry } }))
      if (read.again) get().loadProjectHistory(cwd, true)
    }
    window.qclod.projectHistory(cwd).then(
      (items) => done({ items }),
      (err: unknown) => done({ items: [], error: err instanceof Error ? err.message : String(err) })
    )
  },

  setTabs: (tabs) =>
    set((state) => {
      const busySince = tabs.reduce<Record<TabId, number>>((acc, tab) => {
        const working = tab.status === 'busy' || tab.status === 'waiting'
        const previous = state.tabs.find((t) => t.id === tab.id)
        const wasWorking = previous?.status === 'busy' || previous?.status === 'waiting'
        if (working) acc[tab.id] = wasWorking ? (state.busySinceByTab[tab.id] ?? Date.now()) : Date.now()
        return acc
      }, {})
      const before = state.busySinceByTab
      // Statuses that did not change keep the same object: readers key on it.
      const unchanged =
        Object.keys(busySince).length === Object.keys(before).length &&
        Object.entries(busySince).every(([id, at]) => before[id] === at)
      return {
        tabs,
        // A closed tab's data goes with it. Only tabs this store has seen in
        // `tabs` are forgotten: a new tab's ribbon events can precede the list.
        ...forgetClosed(state, tabs),
        closedTabs: closedAfter(state, tabs),
        busySinceByTab: unchanged ? before : busySince,
        // Main's layout may have come before the tabs: it is applied now, once.
        ...(state.layoutPending && tabs.length > 0
          ? applyLayout(state, state.layout, tabs)
          : savedPanesArrived(state, tabs)
            ? applyLayout(state, { ...state.layout, active: state.activeTabId }, tabs)
            : paneStateAfter(state, tabs))
      }
    }),

  // The snapshot is the whole ribbon at its revision: it replaces whatever
  // the window holds unless that is already newer. Events it already holds
  // arrive later with a revision no newer than it, and are dropped.
  setRibbon: (id, snapshot) =>
    set((state) => {
      if (state.closedTabs.has(id) || snapshot.rev < (state.ribbonRevByTab[id] ?? -1)) return state
      // A whole ribbon at once may carry writes this window never saw arrive.
      const known = state.pathsByTab[id]
      const paths = withoutMissing(known)
      return {
        ...(paths !== known && paths ? { pathsByTab: { ...state.pathsByTab, [id]: paths } } : {}),
        ribbonByTab: { ...state.ribbonByTab, [id]: snapshot.items },
        ribbonRevByTab: { ...state.ribbonRevByTab, [id]: snapshot.rev },
        ...(snapshot.todo ? { todoByTab: { ...state.todoByTab, [id]: snapshot.todo } } : {})
      }
    }),

  applyRibbon: (id, changes, rev) =>
    set((state) => {
      if (state.closedTabs.has(id) || rev <= (state.ribbonRevByTab[id] ?? -1)) return state
      const { items, todo } = reduceRibbon(state.ribbonByTab[id] ?? [], changes)
      const known = state.pathsByTab[id]
      const paths = finishesWrite(items, changes) ? withoutMissing(known) : known
      return {
        ribbonByTab: { ...state.ribbonByTab, [id]: items },
        ribbonRevByTab: { ...state.ribbonRevByTab, [id]: rev },
        ...(paths !== known && paths ? { pathsByTab: { ...state.pathsByTab, [id]: paths } } : {}),
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
      const at = Date.now()
      for (const [raw, target] of answers) {
        // Re-inserted, so a fresh answer counts as the newest one.
        next.delete(raw)
        next.set(raw, { target, at })
      }
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
    })),

  setPaneLayer: (tabId, layer) => set((state) => ({ layerByTab: { ...state.layerByTab, [tabId]: layer } })),
  setPanelChoice: (tabId, choice) =>
    set((state) =>
      (state.panelChoiceByTab[tabId] ?? null) === choice
        ? state
        : { panelChoiceByTab: { ...state.panelChoiceByTab, [tabId]: choice } }
    ),
  // One layer per pane (сверка F9): the agents replace a git or file layer.
  openAgents: (tabId, agentId) =>
    get().setPaneLayer(tabId, agentId ? { kind: 'agents', agentId } : { kind: 'agents' }),
  closeAgents: (tabId) => get().setPaneLayer(tabId, null),
  setAgentsView: (agentsView) => set((state) => (state.agentsView === agentsView ? state : { agentsView })),
  setAgentDraft: (key, text) =>
    set((state) => {
      if ((state.agentDrafts[key] ?? '') === text) return state
      const agentDrafts = { ...state.agentDrafts }
      if (text === '') delete agentDrafts[key]
      else agentDrafts[key] = text
      return { agentDrafts }
    })
}))

// Written on change, so a reload (Ctrl+R) at any moment finds the latest.
useAppStore.subscribe((state, before) => {
  if (
    state.draftByTab === before.draftByTab &&
    state.attachmentsByTab === before.attachmentsByTab &&
    state.agentsView === before.agentsView
  ) {
    return
  }
  try {
    ui()?.setItem(UI_KEY, serializeUi(state))
  } catch {
    // Storage full or blocked: the draft just does not survive a reload.
  }
})
