import { projectKey, projectName } from '../../shared/projects'
import type { ProjectEntry, ServerView, SessionSummary, TabId, TabState } from '../../shared/types'

/**
 * What the window has learned about one project's past conversations:
 * 'loading' — the first read, nothing known yet; `reading` — read again, the
 * list it had stays until the answer (S2-R18).
 */
export type ProjectHistory = { items: SessionSummary[]; error?: string; reading?: true } | 'loading'

/** How many panes a window can hold. */
export const MAX_PANES = 4

export interface SidebarProject {
  key: string
  cwd: string
  name: string
  collapsed: boolean
  /** Open chats, in the order of `tabs`. */
  chats: TabState[]
  /** null: nobody asked yet. */
  past: SessionSummary[] | 'loading' | { error: string } | null
  /** Stage 6: a folder on a server — its label and colour (a ServerColour, drawn by servers.css). */
  remote?: { hostId: string; label: string; color: string }
}

/**
 * The sidebar: projects in their saved order, then the folders of open chats
 * that are not saved yet. One folder written two ways is one project (projectKey).
 */
export function buildSidebar(
  tabs: TabState[],
  projects: ProjectEntry[],
  history: Record<string, ProjectHistory>,
  /** Stage 6: the servers, for a server project's label and colour. */
  servers: ServerView[] = []
): SidebarProject[] {
  const byKey = new Map<string, SidebarProject>()
  const add = (cwd: string, collapsed: boolean, hostId?: string): SidebarProject => {
    const key = projectKey(cwd, hostId)
    const known = byKey.get(key)
    if (known) return known
    const made: SidebarProject = { key, cwd, name: projectName(cwd), collapsed, chats: [], past: null }
    if (hostId) {
      const server = servers.find((s) => s.id === hostId)
      made.remote = { hostId, label: server?.label ?? hostId, color: server?.colour ?? '' }
    }
    byKey.set(key, made)
    return made
  }
  for (const entry of projects) add(entry.cwd, entry.collapsed, entry.hostId)
  // One folder on two servers and here is three projects (сверка F6).
  for (const tab of tabs) add(tab.cwd, false, tab.server?.hostId).chats.push(tab)

  for (const project of byKey.values()) {
    const found = history[project.key]
    if (found === undefined) continue
    if (found === 'loading') {
      project.past = 'loading'
    } else if (found.error !== undefined) {
      project.past = { error: found.error }
    } else {
      const open = new Set(project.chats.map((c) => c.lastSessionId).filter((id): id is string => !!id))
      const past = found.items.filter((s) => !open.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt)
      // Read again: what was there stays; «Загружаю…» only when there is nothing to show.
      project.past = found.reading && past.length === 0 ? 'loading' : past
    }
  }
  return [...byKey.values()]
}

/** The chats top to bottom as the sidebar shows them: the order of Ctrl+Tab and Ctrl+1…9. */
export function chatOrder(sidebar: SidebarProject[]): TabId[] {
  return sidebar.flatMap((p) => p.chats.map((c) => c.id))
}

/**
 * The panes after the window asked for `ids`: no duplicates, at most MAX_PANES.
 * When the active chat is no longer a pane, the first pane takes over and
 * `activate` says so, so that main hears of it.
 */
export function nextPanes(
  state: { paneTabIds: TabId[]; activeTabId: TabId },
  ids: TabId[]
): { paneTabIds: TabId[]; activeTabId: TabId; activate?: TabId } {
  const paneTabIds = [...new Set(ids)].slice(0, MAX_PANES)
  if (paneTabIds.length === 0 || paneTabIds.includes(state.activeTabId)) {
    return { paneTabIds, activeTabId: state.activeTabId }
  }
  const first = paneTabIds[0]!
  return { paneTabIds, activeTabId: first, activate: first }
}
