import { ipcMain } from 'electron'
import { CHANNELS } from '../shared/channels'
import type { CommitResult, GitFileDiff, GitStatus } from '../shared/types'
import type { GitService, GitTab } from './git/GitService'

const MAX_TAB_ID = 64
const MAX_PATH = 4_096
const MAX_PATHS = 2_000

const isString = (v: unknown): v is string => typeof v === 'string'

/**
 * The window names a chat and (for diff and commit) paths; the folder is main's
 * own — from the open tabs. A tab that is not open is no folder at all. The
 * paths are then checked again against the tab's last status in GitService.
 */
export function registerGitIpc(deps: { service: GitService; tabs: () => GitTab[] }): void {
  const tabOf = (id: unknown): GitTab | null => {
    if (!isString(id) || id.length > MAX_TAB_ID) return null
    return deps.tabs().find((t) => t.id === id) ?? null
  }
  const noChat = 'Нет такого чата.'

  ipcMain.handle(CHANNELS.gitStatus, async (_e, tabId: unknown): Promise<GitStatus> => {
    const tab = tabOf(tabId)
    if (!tab) return { kind: 'error', message: noChat }
    return deps.service.status(tab)
  })

  ipcMain.handle(CHANNELS.gitDiff, async (_e, tabId: unknown, path: unknown): Promise<GitFileDiff> => {
    const tab = tabOf(tabId)
    if (!tab) return { kind: 'error', message: noChat }
    if (!isString(path) || path === '' || path.length > MAX_PATH) {
      return { kind: 'error', message: 'Файл не в списке изменений.' }
    }
    return deps.service.diff(tab, path)
  })

  ipcMain.handle(
    CHANNELS.gitCommit,
    async (_e, tabId: unknown, paths: unknown, message: unknown): Promise<CommitResult> => {
      const tab = tabOf(tabId)
      if (!tab) return { ok: false, reason: 'failed', message: noChat }
      if (
        !Array.isArray(paths) ||
        paths.length > MAX_PATHS ||
        !paths.every((p) => isString(p) && p !== '' && p.length <= MAX_PATH) ||
        !isString(message)
      ) {
        return { ok: false, reason: 'failed', message: 'Неверный запрос на коммит.' }
      }
      return deps.service.commit(tab, paths as string[], message)
    }
  )
}
