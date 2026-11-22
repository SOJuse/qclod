import { describe, expect, test, vi } from 'vitest'
import { CHANNELS } from '@shared/channels'
import { registerGitIpc } from '@main/gitIpc'
import type { GitService, GitTab } from '@main/git/GitService'

type Handler = (e: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }
}))

function setup() {
  const seen: GitTab[] = []
  const service = {
    status: vi.fn(async (tab: GitTab) => (seen.push(tab), { kind: 'notRepo' as const })),
    diff: vi.fn(async (tab: GitTab) => (seen.push(tab), { kind: 'binary' as const })),
    commit: vi.fn(async (tab: GitTab) => (seen.push(tab), { ok: true as const, hash: 'abc', summary: 's' }))
  }
  registerGitIpc({ service: service as unknown as GitService, tabs: () => [{ id: 'a', cwd: 'C:/proj' }] })
  const call = (ch: string, ...args: unknown[]): Promise<unknown> => handlers.get(ch)!({}, ...args)
  return { service, seen, call }
}

describe('git ipc', () => {
  test('чужой tabId и не-строки отвергаются', async () => {
    const { service, call } = setup()
    expect(await call(CHANNELS.gitStatus, 'zzz')).toEqual({ kind: 'error', message: 'Нет такого чата.' })
    expect(await call(CHANNELS.gitStatus, 42)).toMatchObject({ kind: 'error' })
    expect(await call(CHANNELS.gitStatus, 'a'.repeat(65))).toMatchObject({ kind: 'error' })
    expect(await call(CHANNELS.gitDiff, 'a', 5)).toMatchObject({ kind: 'error' })
    expect(await call(CHANNELS.gitDiff, 'a', 'x'.repeat(5000))).toMatchObject({ kind: 'error' })
    expect(await call(CHANNELS.gitCommit, 'zzz', ['f'], 'm')).toMatchObject({ ok: false, reason: 'failed' })
    expect(await call(CHANNELS.gitCommit, 'a', 'f', 'm')).toMatchObject({ ok: false })
    expect(await call(CHANNELS.gitCommit, 'a', ['f', 3], 'm')).toMatchObject({ ok: false })
    expect(await call(CHANNELS.gitCommit, 'a', ['f'], { x: 1 })).toMatchObject({ ok: false })
    expect(service.status).not.toHaveBeenCalled()
    expect(service.diff).not.toHaveBeenCalled()
    expect(service.commit).not.toHaveBeenCalled()
  })

  test('окно не может передать cwd: папка берётся только из tabs()', async () => {
    const { service, seen, call } = setup()
    await call(CHANNELS.gitStatus, 'a', { cwd: 'C:/evil' })
    await call(CHANNELS.gitDiff, 'a', 'f.txt', 'C:/evil')
    await call(CHANNELS.gitCommit, 'a', ['f.txt'], 'm', { cwd: 'C:/evil' })
    expect(service.status).toHaveBeenCalledTimes(1)
    expect(service.commit).toHaveBeenCalledWith({ id: 'a', cwd: 'C:/proj' }, ['f.txt'], 'm')
    expect(seen.every((t) => t.cwd === 'C:/proj')).toBe(true)
  })
})
