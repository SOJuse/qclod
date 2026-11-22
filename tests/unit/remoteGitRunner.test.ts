import { afterEach, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitService } from '@main/git/GitService'
import { GIT_BASE_ARGS, GitMissingError, localGitRunner, type GitRun } from '@main/git/gitRunner'
import { REMOTE_GIT_TEXT, remoteGitRunner } from '@main/git/remoteGitRunner'
import { RelayCallError } from '@main/ssh/relayClient'
import type { RelayReader } from '@main/ssh/remoteFiles'

interface Call {
  m: string
  p: Record<string, unknown>
  o?: { timeoutMs?: number }
}

/** A relay that records what it is asked and answers from `answer`. */
function stub(answer: (p: Record<string, unknown>) => GitRun | Promise<GitRun>): { client: () => Promise<RelayReader>; calls: Call[] } {
  const calls: Call[] = []
  const reader: RelayReader = {
    call: async <T,>(m: string, p: unknown, o?: { timeoutMs?: number }): Promise<T> => {
      calls.push({ m, p: p as Record<string, unknown>, ...(o ? { o } : {}) })
      return (await answer(p as Record<string, unknown>)) as T
    }
  } as RelayReader
  return { client: async () => reader, calls }
}

const OK = (stdout = ''): GitRun => ({ code: 0, stdout, stderr: '', truncated: false })

describe('remoteGitRunner (этап 7, задача 15)', () => {
  test('args с путём «-rf [1] Привет \'x\'.txt» доходят целыми; git и GIT_BASE_ARGS клиент не шлёт', async () => {
    const s = stub(() => OK('out'))
    const run = remoteGitRunner(s.client, '/srv/app')
    const out = await run(['diff', '--', "-rf [1] Привет 'x'.txt"], { readOnly: true })
    expect(out).toEqual(OK('out'))
    expect(s.calls).toHaveLength(1)
    const [call] = s.calls
    expect(call!.m).toBe('git.run')
    expect(call!.p['cwd']).toBe('/srv/app')
    expect(call!.p['args']).toEqual(['diff', '--', "-rf [1] Привет 'x'.txt"])
    expect(call!.p['args']).not.toContain('git')
    for (const base of GIT_BASE_ARGS.filter((a) => a !== '-c')) expect(call!.p['args']).not.toContain(base)
    expect(call!.p['readOnly']).toBe(true)
    expect(typeof call!.p['timeoutMs']).toBe('number')
    expect(typeof call!.p['maxBytes']).toBe('number')
    // The relay's own answer gets more time than git's run.
    expect(call!.o!.timeoutMs!).toBeGreaterThan(call!.p['timeoutMs'] as number)
  })

  test('input доходит; код и потоки возвращаются как есть', async () => {
    const s = stub(() => ({ code: 1, stdout: 'a', stderr: 'b', truncated: true }))
    const out = await remoteGitRunner(s.client, '/srv')(['add', '-A', '--pathspec-from-file=-'], { input: 'x\0y\0' })
    expect(s.calls[0]!.p['input']).toBe('x\0y\0')
    expect(s.calls[0]!.p).not.toHaveProperty('readOnly')
    expect(out).toEqual({ code: 1, stdout: 'a', stderr: 'b', truncated: true })
  })

  test('нет git на сервере (127, «git not found») — GitMissingError', async () => {
    const s = stub(() => ({ code: 127, stdout: '', stderr: 'git not found', truncated: false }))
    await expect(remoteGitRunner(s.client, '/srv')(['status'])).rejects.toBeInstanceOf(GitMissingError)
  })

  test('offline и unsupported дают unavailable с текстами; кнопка Git неактивна с подсказкой', async () => {
    const offline = remoteGitRunner(async () => {
      throw new RelayCallError('offline', 'нет связи')
    }, '/srv')
    const noLink = remoteGitRunner(async () => {
      throw new Error('Сервер не отвечает')
    }, '/srv')
    const old = remoteGitRunner(
      stub(() => {
        throw new RelayCallError('unsupported', 'git.run появится в этапе 7')
      }).client,
      '/srv'
    )
    const dropped = remoteGitRunner(
      stub(() => {
        throw new RelayCallError('offline', 'связь пропала')
      }).client,
      '/srv'
    )
    const tab = { id: 't1', cwd: '/srv', hostId: 'h1' }
    for (const [run, reason] of [
      [offline, REMOTE_GIT_TEXT.offline],
      [noLink, REMOTE_GIT_TEXT.offline],
      [dropped, REMOTE_GIT_TEXT.offline],
      [old, REMOTE_GIT_TEXT.oldRelay]
    ] as const) {
      expect(await new GitService(() => run).status(tab)).toEqual({ kind: 'unavailable', reason })
    }
    expect(REMOTE_GIT_TEXT.oldRelay).toBe('Обновите посредник Qclod в настройках «Серверы»')
    expect(REMOTE_GIT_TEXT.offline).toBe('Сервер не на связи')
  })
})

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const git = hasGit()
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('GitService на удалённом runner', () => {
  test.skipIf(!git)('записанный вывод porcelain даёт те же изменения, что локально', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-remotegit-'))
    dirs.push(dir)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    writeFileSync(join(dir, 'новый файл.txt'), 'x\n')

    // What git says locally is what the relay would answer: recorded, then replayed.
    const local = localGitRunner(dir)
    const recorded = new Map<string, GitRun>()
    const s = stub(async (p) => {
      const key = JSON.stringify(p['args'])
      if (!recorded.has(key)) recorded.set(key, await local(p['args'] as string[], { readOnly: p['readOnly'] === true }))
      return recorded.get(key)!
    })
    const tab = { id: 't1', cwd: dir }
    const viaLocal = await new GitService(() => local).status(tab)
    const viaRelay = await new GitService(() => remoteGitRunner(s.client, dir)).status({ ...tab, hostId: 'h1' })
    expect(viaLocal.kind).toBe('ok')
    expect(viaRelay).toEqual(viaLocal)
    expect(s.calls.every((c) => c.m === 'git.run' && c.p['cwd'] === dir)).toBe(true)
  })
})
