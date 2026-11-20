import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LAYOUT, type LayoutPatch, type LayoutState, type ProjectEntry, type TabId } from '../../shared/types'
import { projectKey } from '../../shared/projects'
import { sanitizeLayoutPatch } from '../tabs/sanitize'

export const LAYOUT_FILE = 'layout.json'

/** No pane of a split is narrower than this share of the row. */
const MIN_WIDTH = 0.05

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The share of the row each of `count` panes takes: `count` numbers, each at
 * least 0.05, adding up to 1. Widths that do not match the count, or that
 * cannot be read as shares (not finite, nothing above zero), give equal panes.
 */
export function normalizeWidths(widths: number[], count: number): number[] {
  if (count <= 0) return []
  const equal = Array.from({ length: count }, () => 1 / count)
  if (widths.length !== count || count * MIN_WIDTH >= 1) return equal
  if (!widths.every((w) => Number.isFinite(w))) return equal
  const shares = widths.map((w) => Math.max(0, w))
  const total = shares.reduce((a, b) => a + b, 0)
  if (total <= 0) return equal

  // Panes below the minimum are raised to it, and the rest share what is left
  // in their own proportions; raising one may push another under, so again.
  const out = shares.map((w) => w / total)
  const pinned = new Set<number>()
  for (;;) {
    const free = out.map((_w, i) => i).filter((i) => !pinned.has(i))
    const room = 1 - pinned.size * MIN_WIDTH
    const freeTotal = free.reduce((sum, i) => sum + out[i]!, 0)
    for (const i of free) out[i] = freeTotal > 0 ? (out[i]! / freeTotal) * room : room / free.length
    for (const i of pinned) out[i] = MIN_WIDTH
    const under = free.filter((i) => out[i]! < MIN_WIDTH)
    if (under.length === 0) return out
    for (const i of under) pinned.add(i)
  }
}

/** One entry per folder (`projectKey`), the first spelling kept; anything unreadable dropped. */
function readProjects(value: unknown): ProjectEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: ProjectEntry[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) continue
    const { cwd, collapsed, hostId } = entry
    if (typeof cwd !== 'string' || cwd === '') continue
    const host = typeof hostId === 'string' && hostId !== '' ? hostId : undefined
    const key = projectKey(cwd, host)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ cwd, collapsed: collapsed === true, ...(host ? { hostId: host } : {}) })
  }
  return out
}

function copyLayout(layout: LayoutState): LayoutState {
  return {
    panes: [...layout.panes],
    active: layout.active,
    paneWidths: [...layout.paneWidths],
    sidebarCollapsed: layout.sidebarCollapsed,
    projects: layout.projects.map((p) => ({ ...p }))
  }
}

/**
 * The window's layout as last saved. A convenience, never a gate: a missing,
 * unparseable or hand-edited file costs only the fields that cannot be read,
 * each falling back to its default on its own.
 */
export function loadLayout(dir: string): LayoutState {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, LAYOUT_FILE), 'utf8'))
  } catch {
    return copyLayout(DEFAULT_LAYOUT)
  }
  if (!isPlainObject(parsed)) return copyLayout(DEFAULT_LAYOUT)

  // The window's own patch rules hold for what is read back, too.
  const clean = sanitizeLayoutPatch(parsed)
  const panes = clean.panes ?? []
  const active = parsed['active']
  return {
    panes,
    active: typeof active === 'string' && active !== '' ? active : null,
    paneWidths: normalizeWidths(clean.paneWidths ?? [], panes.length),
    sidebarCollapsed: clean.sidebarCollapsed ?? false,
    projects: readProjects(parsed['projects'])
  }
}

/**
 * `userData/layout.json`: which chats are in the split and how wide, which
 * one is active, the sidebar, and the projects — the folders the sidebar
 * lists, which stay after their last chat is closed. Kept in main because
 * main decides which chats get an agent, and it has to survive a restart.
 * Only ids and folders are written, never a word of a conversation.
 */
export class LayoutStore {
  private state: LayoutState

  constructor(
    private readonly dir: string,
    private readonly onChange: (l: LayoutState) => void
  ) {
    this.state = loadLayout(dir)
  }

  get(): LayoutState {
    return copyLayout(this.state)
  }

  /** `p` is already clean (sanitizeLayoutPatch). Widths always follow the panes' count. */
  patch(p: LayoutPatch): LayoutState {
    const next = copyLayout(this.state)
    if (p.panes) next.panes = [...p.panes]
    if (p.paneWidths || next.panes.length !== this.state.panes.length) {
      next.paneWidths = normalizeWidths(p.paneWidths ?? next.paneWidths, next.panes.length)
    }
    if (p.sidebarCollapsed !== undefined) next.sidebarCollapsed = p.sidebarCollapsed
    if (p.projectCollapsed) {
      // Only a folder that is a project already: collapsing makes none.
      const key = projectKey(p.projectCollapsed.cwd)
      const project = next.projects.find((e) => projectKey(e.cwd, e.hostId) === key)
      if (project) project.collapsed = p.projectCollapsed.collapsed
    }
    this.commit(next)
    return this.get()
  }

  setActive(id: TabId | null): void {
    this.commit({ ...copyLayout(this.state), active: id })
  }

  /** The folder becomes a project, once however its path is written. */
  addProject(cwd: string, hostId?: string): void {
    const key = projectKey(cwd, hostId)
    if (this.state.projects.some((e) => projectKey(e.cwd, e.hostId) === key)) return
    const next = copyLayout(this.state)
    next.projects.push({ cwd, collapsed: false, ...(hostId ? { hostId } : {}) })
    this.commit(next)
  }

  /**
   * «Убрать из списка». `openKeys` are the `projectKey`s of the open chats: a
   * project one of them is in stays, and nothing changes (false).
   */
  forgetProject(cwd: string, openKeys: string[], hostId?: string): boolean {
    const key = projectKey(cwd, hostId)
    if (openKeys.includes(key)) return false
    const next = copyLayout(this.state)
    next.projects = next.projects.filter((e) => projectKey(e.cwd, e.hostId) !== key)
    this.commit(next)
    return true
  }

  /**
   * Drops panes whose chat is gone and gives the rest the row in their old
   * proportions. A dead active chat is forgotten; who becomes active is the
   * controller's to say.
   */
  prune(aliveTabIds: TabId[]): void {
    const alive = new Set(aliveTabIds)
    const next = copyLayout(this.state)
    const kept = next.panes.map((id, i) => [id, i] as const).filter(([id]) => alive.has(id))
    if (kept.length !== next.panes.length) {
      const matched = next.paneWidths.length === next.panes.length
      next.panes = kept.map(([id]) => id)
      next.paneWidths = normalizeWidths(
        matched ? kept.map(([, i]) => next.paneWidths[i]!) : next.paneWidths,
        next.panes.length
      )
    }
    if (next.active !== null && !alive.has(next.active)) next.active = null
    this.commit(next)
  }

  /** Written and told only when something did change. */
  private commit(next: LayoutState): void {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(join(this.dir, LAYOUT_FILE), JSON.stringify(next, null, 2), 'utf8')
    } catch (err) {
      // A layout that cannot be saved is lost on restart, not now.
      console.warn('[layout]', err instanceof Error ? err.message : String(err))
    }
    this.onChange(this.get())
  }
}
