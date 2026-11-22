import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { AskpassServer } from '@main/ssh/askpass'
import { runAskpassClient } from '@main/ssh/askpassClient'
import { PausableTimeout, setSshContext, sshRun, type SpawnFn } from '@main/ssh/sshRun'
import type { SshPrompt, SshPromptAnswer } from '@shared/types'

const PASSWORD = "me@box's password: "
const HOST_KEY =
  "The authenticity of host 'box (10.0.0.2)' can't be established.\n" +
  'ED25519 key fingerprint is SHA256:d7Te2DHmvBNSWJNBWik2KbDTjmWtYHe2bvXTMM9lVg4.\n' +
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? '

let userData = ''
let askpass: AskpassServer | null = null
beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'qclod-sshrun-'))
})
afterEach(async () => {
  setSshContext(null)
  await askpass?.stop()
  askpass = null
  rmSync(userData, { recursive: true, force: true })
})

/**
 * A stand-in for ssh: asks askpass what `script` says, then exits as the
 * script decides — the way the real one does with NumberOfPasswordPrompts=1.
 */
function fakeSsh(script: (ask: (prompt: string) => Promise<string | null>) => Promise<{ code: number; stdout?: string; stderr?: string }>) {
  let killed = 0
  const spawn: SpawnFn = (_file, _args, o) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    Object.assign(child, { stdout, stderr, stdin: new PassThrough(), kill: () => ((killed += 1), true) })
    const env = o.env as Record<string, string>
    const ask = async (prompt: string): Promise<string | null> => {
      let out = ''
      const code = await runAskpassClient([prompt], env, (s) => {
        out += s
      })
      return code === 0 ? out.replace(/\n$/, '') : null
    }
    void script(ask).then((r) => {
      if (r.stdout) stdout.write(r.stdout)
      if (r.stderr) stderr.write(r.stderr)
      setTimeout(() => child.emit('close', r.code), 5)
    })
    return child
  }
  return { spawn, killed: () => killed }
}

async function context(spawn: SpawnFn, o: { stored?: string | null; ask?: (p: SshPrompt) => Promise<SshPromptAnswer> } = {}) {
  let stored = o.stored ?? null
  askpass = new AskpassServer({
    platform: process.platform,
    execPath: process.execPath,
    userData,
    ask: o.ask ?? (async (p) => ({ promptId: p.promptId, ok: false })),
    storedPassword: () => stored,
    onRemember: (_h, pw) => {
      stored = pw
    }
  })
  await askpass.start()
  setSshContext({ sshPath: 'ssh', platform: process.platform, userData, uid: process.getuid?.() ?? 0, askpass, spawn })
  return askpass
}

const target = { target: 'me@box' }

describe('sshRun и askpass (C1)', () => {
  test('сохранённый пароль не подошёл: следующие фоновые запуски его не шлют', async () => {
    const given: Array<string | null> = []
    const ssh = fakeSsh(async (ask) => {
      const answer = await ask(PASSWORD)
      given.push(answer)
      // One question per try (NumberOfPasswordPrompts=1): a wrong one ends the run.
      return { code: 255, stderr: 'me@box: Permission denied (password).\n' }
    })
    const ap = await context(ssh.spawn, { stored: 'old-pw' })
    for (let i = 0; i < 4; i++) {
      const r = await sshRun(target, 'true', { interactive: false, hostId: 'h1' })
      expect(r.code).toBe(255)
    }
    // The server saw the wrong password once, not four times.
    expect(given).toEqual(['old-pw', null, null, null])
    expect(ap.storedRefused('h1')).toBe(true)
  })

  test('пароль с «Запомнить» хранится только после входа', async () => {
    let attempt = 0
    const ssh = fakeSsh(async (ask) => {
      attempt++
      await ask(PASSWORD)
      return attempt === 1 ? { code: 255, stderr: 'Permission denied (password).\n' } : { code: 0, stdout: 'ok\n' }
    })
    const answers = ['typo', 'right']
    const ap = await context(ssh.spawn, {
      ask: async (p) => ({ promptId: p.promptId, ok: true, value: answers.shift()!, remember: true })
    })
    await sshRun(target, 'true', { interactive: true, hostId: 'h1' })
    expect(ap.storedRefused('h1')).toBe(false)
    const second = await sshRun(target, 'true', { interactive: true, hostId: 'h1' })
    expect(second.code).toBe(0)
    // The typo was never kept; the one that got in was.
    const bg: Array<string | null> = []
    const check = fakeSsh(async (ask) => {
      bg.push(await ask(PASSWORD))
      return { code: 0 }
    })
    setSshContext({ sshPath: 'ssh', platform: process.platform, userData, uid: process.getuid?.() ?? 0, askpass: ap, spawn: check.spawn })
    await sshRun(target, 'true', { interactive: false, hostId: 'h1' })
    expect(bg).toEqual(['right'])
  })
})

describe('R4: время вопроса не входит в таймаут запуска', () => {
  test('вопрос о ключе висит дольше timeoutMs — ssh не убит, ответ человека доходит', async () => {
    const ssh = fakeSsh(async (ask) => {
      const yes = await ask(HOST_KEY)
      return yes === 'yes' ? { code: 0, stdout: 'probe\n' } : { code: 255 }
    })
    await context(ssh.spawn, {
      ask: (p) => new Promise((resolve) => setTimeout(() => resolve({ promptId: p.promptId, ok: true, value: 'yes' }), 250))
    })
    const r = await sshRun(target, 'true', { interactive: true, hostId: 'h1', timeoutMs: 80 })
    expect(r).toMatchObject({ code: 0, stdout: 'probe\n' })
    expect(ssh.killed()).toBe(0)
  })

  test('без вопроса таймаут срабатывает как прежде', async () => {
    const ssh = fakeSsh(() => new Promise(() => undefined))
    await context(ssh.spawn)
    const r = await sshRun(target, 'true', { interactive: true, hostId: 'h1', timeoutMs: 40 })
    expect(r.code).toBeNull()
    expect(ssh.killed()).toBe(1)
  })

  test('PausableTimeout: пауза останавливает часы, остаток досчитывается после', async () => {
    let now = 0
    let fired = 0
    const t = new PausableTimeout(50, () => fired++, () => now)
    now = 30
    t.pause()
    await new Promise((r) => setTimeout(r, 80))
    expect(fired).toBe(0)
    now = 1000
    t.resume()
    // 20 ms were left.
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toBe(1)
  })
})
