import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { LaunchOverrides, SessionStatus, TabId, TabState } from '../../shared/types'
import { isDirectory, loadTabs, saveTabs, type LoadedTab } from '../store/tabsStore'
import type { SessionManager } from '../sessions/SessionManager'
import { AgentNotFoundError } from '../sessions/resolveExecutable'

export interface TabControllerDeps {
  manager: SessionManager
  storeDir: string
  /** Where a tab lands when nothing else is known. */
  defaultCwd: string
  onData: (tabId: TabId, chunk: string) => void
  onExit: (tabId: TabId, code: number) => void
  onChanged: (tabs: TabState[]) => void
}

/** Owns the list of tabs and keeps each one's session in step with it. */
export class TabController {
  private tabs: TabState[] = []
  private activeId: TabId | null = null

  constructor(private readonly deps: TabControllerDeps) {}

  list(): TabState[] {
    return this.tabs.map((tab) => ({ ...tab }))
  }

  get activeTabId(): TabId | null {
    return this.activeId
  }

  /**
   * Brings back last run's tabs by working directory. Sessions always start
   * fresh — `--resume` is deliberately not used (spec 6.3).
   */
  restore(): TabState[] {
    const stored: LoadedTab[] = loadTabs(this.deps.storeDir)
    if (stored.length === 0) {
      this.create(this.deps.defaultCwd)
      return this.list()
    }

    for (const tab of stored) {
      this.adopt({
        id: tab.id,
        cwd: tab.cwd,
        title: tab.title,
        overrides: tab.overrides,
        status: 'starting',
        badge: false,
        degraded: false,
        missingCwd: tab.missingCwd
      })
    }
    this.activeId = this.tabs[0]?.id ?? null
    this.emit()
    return this.list()
  }

  create(cwd: string, overrides: LaunchOverrides = {}, title?: string): TabState {
    const tab: TabState = {
      id: randomUUID(),
      cwd,
      title: title ?? basename(cwd) ?? cwd,
      overrides,
      status: 'starting',
      badge: false,
      degraded: false,
      missingCwd: !isDirectory(cwd)
    }
    this.adopt(tab)
    this.activeId = tab.id
    this.emit()
    return { ...tab }
  }

  async close(id: TabId): Promise<void> {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    this.tabs.splice(index, 1)
    await this.deps.manager.close(id)

    if (this.activeId === id) {
      this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id ?? null
    }
    // Never leave the window with nothing in it.
    if (this.tabs.length === 0) this.create(this.deps.defaultCwd)
    else this.emit()
  }

  activate(id: TabId): void {
    const tab = this.find(id)
    if (!tab) return
    this.activeId = id
    tab.badge = false
    this.emit()
  }

  update(id: TabId, patch: Partial<TabState>): TabState | undefined {
    const tab = this.find(id)
    if (!tab) return undefined
    Object.assign(tab, patch)
    this.emit()
    return { ...tab }
  }

  setStatus(id: TabId, status: SessionStatus, degraded = false): void {
    const tab = this.find(id)
    if (!tab) return
    tab.status = status
    tab.degraded = degraded
    // Something finished or wants an answer while you were looking elsewhere.
    if (id !== this.activeId && (status === 'idle' || status === 'waiting')) tab.badge = true
    this.emit()
  }

  async restart(id: TabId): Promise<void> {
    const tab = this.find(id)
    if (!tab) return
    await this.deps.manager.close(id)
    tab.status = 'starting'
    tab.exitCode = undefined
    tab.missingCwd = !isDirectory(tab.cwd)
    this.startSession(tab)
    this.emit()
  }

  private adopt(tab: TabState): void {
    this.tabs.push(tab)
    this.startSession(tab)
  }

  private startSession(tab: TabState): void {
    if (tab.missingCwd) {
      // The folder is gone. The tab stays and explains itself rather than
      // disappearing with the user's context.
      tab.status = 'error'
      tab.error = `Папка больше не существует: ${tab.cwd}`
      return
    }

    try {
      const session = this.deps.manager.create(tab.id, tab.cwd, tab.overrides)
      session.onData((chunk) => this.deps.onData(tab.id, chunk))
      session.onExit((code) => {
        const current = this.find(tab.id)
        if (current) {
          current.status = 'exited'
          current.exitCode = code
          this.emit()
        }
        this.deps.onExit(tab.id, code)
      })
      session.start()
      tab.status = 'idle'
      tab.error = undefined
    } catch (error) {
      tab.status = 'error'
      tab.error =
        error instanceof AgentNotFoundError
          ? error.message
          : `Не удалось запустить агента: ${String(error)}`
    }
  }

  private find(id: TabId): TabState | undefined {
    return this.tabs.find((tab) => tab.id === id)
  }

  private emit(): void {
    saveTabs(this.deps.storeDir, this.tabs)
    this.deps.onChanged(this.list())
  }
}
