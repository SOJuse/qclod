/**
 * The window's side of the servers (stage 6): the list, the form, the
 * checklist, ssh's questions, a folder there. Every argument is checked here
 * before it reaches ssh or a relay (sanitize.ts): a target that starts with
 * `-` would be an ssh option, a path with a NUL no path at all.
 */
import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/channels'
import type { ServerView, SshPromptAnswer, TabState } from '../../shared/types'
import type { FsEntry } from '../../shared/relayProtocol'
import {
  sanitizeHostId,
  sanitizePromptAnswer,
  sanitizeRemotePath,
  sanitizeServerEntry,
  sanitizeServerPassword
} from '../tabs/sanitize'
import type { HostManager } from './hostManager'

export interface ServerIpcDeps {
  hosts: Pick<
    HostManager,
    'list' | 'save' | 'remove' | 'connect' | 'forgetPassword' | 'listDir' | 'openFolder' | 'updateRelay'
  >
  /** An answer of the window to a question ssh asked; one nobody asked does nothing. */
  askpassAnswers: (a: SshPromptAnswer) => void
  /** Task 23: `claude auth login` on the server. */
  login?: { start(hostId: string): Promise<void>; code(hostId: string, code: string): void }
}

const SAVE_REFUSED = 'Проверьте хост и порт: так подключиться нельзя.'

export function registerServerIpc(deps: ServerIpcDeps): void {
  const { hosts } = deps

  ipcMain.handle(CHANNELS.serversList, (): ServerView[] => hosts.list())

  ipcMain.handle(CHANNELS.serversSave, (_e, entry: unknown, password: unknown): ServerView[] => {
    const clean = sanitizeServerEntry(entry)
    if (!clean) throw new Error(SAVE_REFUSED)
    const pw = password === undefined ? undefined : sanitizeServerPassword(password)
    return hosts.save(clean, pw ?? undefined)
  })

  ipcMain.handle(CHANNELS.serversRemove, (_e, hostId: unknown): ServerView[] => {
    const id = sanitizeHostId(hostId)
    return id ? hosts.remove(id) : hosts.list()
  })

  ipcMain.handle(CHANNELS.serversConnect, async (_e, hostId: unknown): Promise<boolean> => {
    const id = sanitizeHostId(hostId)
    return id ? hosts.connect(id, true) : false
  })

  ipcMain.handle(CHANNELS.serversForgetPassword, (_e, hostId: unknown): void => {
    const id = sanitizeHostId(hostId)
    if (id) hosts.forgetPassword(id)
  })

  ipcMain.handle(CHANNELS.serversPromptAnswer, (_e, answer: unknown): void => {
    const clean = sanitizePromptAnswer(answer)
    if (clean) deps.askpassAnswers(clean)
  })

  ipcMain.handle(
    CHANNELS.serversListDir,
    async (_e, hostId: unknown, path: unknown): Promise<{ path: string; entries: FsEntry[]; truncated: boolean }> => {
      const id = sanitizeHostId(hostId)
      const where = sanitizeRemotePath(path)
      if (!id || where === null) throw new Error('Такого пути нет')
      return hosts.listDir(id, where)
    }
  )

  ipcMain.handle(CHANNELS.serversOpenFolder, (_e, hostId: unknown, path: unknown): TabState | null => {
    const id = sanitizeHostId(hostId)
    const where = sanitizeRemotePath(path)
    if (!id || where === null || where === '') return null
    try {
      return hosts.openFolder(id, where)
    } catch {
      return null
    }
  })

  ipcMain.handle(CHANNELS.serversUpdateRelay, async (_e, hostId: unknown, force: unknown): Promise<void> => {
    const id = sanitizeHostId(hostId)
    if (id) await hosts.updateRelay(id, force === true)
  })

  ipcMain.handle(CHANNELS.serversLogin, async (_e, hostId: unknown): Promise<void> => {
    const id = sanitizeHostId(hostId)
    if (id && deps.login) await deps.login.start(id)
  })

  ipcMain.handle(CHANNELS.serversLoginCode, (_e, hostId: unknown, code: unknown): void => {
    const id = sanitizeHostId(hostId)
    if (!id || typeof code !== 'string' || code.length === 0 || code.length > 4096 || /[\0\r\n]/.test(code)) return
    deps.login?.code(id, code)
  })
}

/** The brief's name for it. */
export const register = registerServerIpc
