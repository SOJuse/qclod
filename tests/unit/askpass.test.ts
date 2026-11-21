import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AskpassServer, classifyPrompt } from '@main/ssh/askpass'
import { runAskpassClient } from '@main/ssh/askpassClient'
import type { SshPrompt, SshPromptAnswer } from '@shared/types'

// The exact lines from the probe (stage 6, task 7), both OpenSSH versions.
const HOST_95 =
  "The authenticity of host 'test.rebex.net (194.108.117.16)' can't be established.\n" +
  'ED25519 key fingerprint is SHA256:d7Te2DHmvBNSWJNBWik2KbDTjmWtYHe2bvXTMM9lVg4.\n' +
  'This key is not known by any other names.\n' +
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
const HOST_102 =
  "The authenticity of host 'test.rebex.net (194.108.117.16)' can't be established.\n" +
  'ED25519 key fingerprint is: SHA256:d7Te2DHmvBNSWJNBWik2KbDTjmWtYHe2bvXTMM9lVg4\n' +
  'This key is not known by any other names.\n' +
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
const PASSWORD = "demo@test.rebex.net's password: "
const KBD = '(demo@test.rebex.net) Password: '
const PASSPHRASE = "Enter passphrase for key 'C:\\Users\\sojuse\\AppData\\Local\\Temp\\qclod-askpass-1\\probe_pem': "

describe('classifyPrompt', () => {
  test('ключ хоста в обеих версиях OpenSSH', () => {
    for (const text of [HOST_95, HOST_102]) {
      expect(classifyPrompt(text)).toEqual({
        kind: 'hostKey',
        host: 'test.rebex.net',
        keyType: 'ED25519',
        fingerprint: 'SHA256:d7Te2DHmvBNSWJNBWik2KbDTjmWtYHe2bvXTMM9lVg4'
      })
    }
  })

  test('пароль и keyboard-interactive', () => {
    expect(classifyPrompt(PASSWORD)).toMatchObject({ kind: 'password', host: 'demo@test.rebex.net' })
    expect(classifyPrompt(KBD)).toMatchObject({ kind: 'password', host: 'demo@test.rebex.net' })
  })

  test('пароль от ключа и прочее', () => {
    expect(classifyPrompt(PASSPHRASE)).toMatchObject({
      kind: 'passphrase',
      keyPath: 'C:\\Users\\sojuse\\AppData\\Local\\Temp\\qclod-askpass-1\\probe_pem'
    })
    expect(classifyPrompt('(demo@host) Verification code: ')).toEqual({ kind: 'other' })
  })
})

let userData = ''
let server: AskpassServer | null = null
beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'qclod-askpass-'))
})
afterEach(async () => {
  await server?.stop()
  server = null
  rmSync(userData, { recursive: true, force: true })
})

interface Harness {
  server: AskpassServer
  asked: SshPrompt[]
  remembered: Array<[string, string]>
  answers: Array<(p: SshPrompt) => Omit<SshPromptAnswer, 'promptId'>>
}

async function harness(stored: string | null = null): Promise<Harness> {
  const asked: SshPrompt[] = []
  const remembered: Array<[string, string]> = []
  const answers: Harness['answers'] = []
  server = new AskpassServer({
    platform: process.platform,
    execPath: process.execPath,
    userData,
    ask: async (p) => {
      asked.push(p)
      const next = answers.shift()
      return { promptId: p.promptId, ...(next ? next(p) : { ok: false }) } as SshPromptAnswer
    },
    storedPassword: () => stored,
    onRemember: (hostId, password) => remembered.push([hostId, password])
  })
  await server.start()
  return { server, asked, remembered, answers }
}

/** What ssh would see: the client's stdout and exit code. */
async function askAs(env: Record<string, string>, prompt: string): Promise<{ code: number; out: string }> {
  let out = ''
  const code = await runAskpassClient([prompt], env, (s) => {
    out += s
  })
  return { code, out }
}

describe('AskpassServer', () => {
  test('сохранённый пароль подаётся один раз', async () => {
    const h = await harness('stored-pw')
    const spawn = h.server.forSpawn('h1', { interactive: false })
    expect(await askAs(spawn.env, PASSWORD)).toEqual({ code: 0, out: 'stored-pw\n' })
    // A second question in the same try: not interactive — refused, nobody asked.
    expect(await askAs(spawn.env, KBD)).toEqual({ code: 1, out: '' })
    expect(h.asked).toEqual([])
    spawn.done()
  })

  test('второй вопрос пароля в той же попытке идёт человеку', async () => {
    const h = await harness('wrong-pw')
    h.answers.push(() => ({ ok: true, value: 'right-pw', remember: true }))
    const spawn = h.server.forSpawn('h1', { interactive: true })
    expect((await askAs(spawn.env, PASSWORD)).out).toBe('wrong-pw\n')
    expect(await askAs(spawn.env, PASSWORD)).toEqual({ code: 0, out: 'right-pw\n' })
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]).toMatchObject({ kind: 'password', hostId: 'h1', retry: true, text: 'demo@test.rebex.net' })
    expect(h.remembered).toEqual([['h1', 'right-pw']])
    // A new try starts over: the stored one goes first again.
    const again = h.server.forSpawn('h1', { interactive: true })
    expect((await askAs(again.env, PASSWORD)).out).toBe('wrong-pw\n')
  })

  test('без сохранённого пароля первый вопрос — человеку без retry', async () => {
    const h = await harness(null)
    h.answers.push(() => ({ ok: true, value: 'typed' }))
    const spawn = h.server.forSpawn('h1', { interactive: true })
    expect((await askAs(spawn.env, PASSWORD)).out).toBe('typed\n')
    expect(h.asked[0]).toMatchObject({ kind: 'password', retry: false })
    expect(h.remembered).toEqual([])
  })

  test('без interactive вопрос о ключе — отказ, человек не спрошен', async () => {
    const h = await harness()
    const spawn = h.server.forSpawn('h1', { interactive: false })
    expect(await askAs(spawn.env, HOST_102)).toEqual({ code: 1, out: '' })
    expect(await askAs(spawn.env, PASSPHRASE)).toEqual({ code: 1, out: '' })
    expect(h.asked).toEqual([])
  })

  test('ключ хоста: «Доверять» печатает yes, «Отмена» — отказ', async () => {
    const h = await harness()
    h.answers.push(() => ({ ok: true, value: 'yes' }), () => ({ ok: false }))
    const spawn = h.server.forSpawn('h1', { interactive: true })
    expect(await askAs(spawn.env, HOST_95)).toEqual({ code: 0, out: 'yes\n' })
    expect(h.asked[0]).toMatchObject({
      kind: 'hostKey',
      host: 'test.rebex.net',
      keyType: 'ED25519',
      fingerprint: 'SHA256:d7Te2DHmvBNSWJNBWik2KbDTjmWtYHe2bvXTMM9lVg4'
    })
    expect(await askAs(spawn.env, HOST_95)).toEqual({ code: 1, out: '' })
  })

  test('пароль от ключа не запоминается', async () => {
    const h = await harness()
    h.answers.push(() => ({ ok: true, value: 'kp', remember: true }))
    const spawn = h.server.forSpawn('h1', { interactive: true })
    expect((await askAs(spawn.env, PASSPHRASE)).out).toBe('kp\n')
    expect(h.asked[0]).toMatchObject({ kind: 'passphrase', canRemember: false })
    expect(h.remembered).toEqual([])
  })

  test('чужой токен — отказ', async () => {
    const h = await harness('pw')
    const spawn = h.server.forSpawn('h1', { interactive: true })
    expect(await askAs({ ...spawn.env, QCLOD_ASKPASS_TOKEN: 'not-the-token' }, PASSWORD)).toEqual({ code: 1, out: '' })
    // Used up after done().
    spawn.done()
    expect(await askAs(spawn.env, PASSWORD)).toEqual({ code: 1, out: '' })
    // No pipe at all: refused as well.
    expect(await askAs({}, PASSWORD)).toEqual({ code: 1, out: '' })
  })

  test('текст вопроса с кавычками и & доходит до ask как есть', async () => {
    const h = await harness()
    h.answers.push(() => ({ ok: true, value: 'x' }))
    const spawn = h.server.forSpawn('h1', { interactive: true })
    const text = `(me@box) Код "из" SMS & 'ещё' %PATH% $HOME: `
    await askAs(spawn.env, text)
    expect(h.asked[0]).toMatchObject({ kind: 'other', text })
  })

  test('env для ssh и askpass.sh', async () => {
    const h = await harness()
    const spawn = h.server.forSpawn('h1', { interactive: true })
    expect(spawn.env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' })
    expect(spawn.env['QCLOD_ASKPASS_PIPE']).toBeTruthy()
    expect(spawn.env['QCLOD_ASKPASS_TOKEN']).toMatch(/^[0-9a-f]{32,}$/)
    if (process.platform === 'win32') expect(spawn.env['SSH_ASKPASS']).toBe(process.execPath)
    else expect(spawn.env['SSH_ASKPASS']).toBe(join(userData, 'ssh', 'askpass.sh'))

    const posix = new AskpassServer({
      platform: 'darwin',
      execPath: '/Applications/Qclod.app/Contents/MacOS/Qclod',
      userData,
      ask: vi.fn(),
      storedPassword: () => null,
      onRemember: vi.fn()
    })
    const script = posix.writeAskpassScript()
    const body = readFileSync(script, 'utf8')
    expect(body.startsWith('#!/bin/sh\n')).toBe(true)
    expect(body).toContain('ELECTRON_RUN_AS_NODE=1 exec ')
    expect(body).toContain("'/Applications/Qclod.app/Contents/MacOS/Qclod'")
    expect(body).toContain('"$@"')
    expect(existsSync(script)).toBe(true)
  })
})

describe('путь askpass не берёт замок экземпляра', () => {
  const root = resolve(__dirname, '../../src/main')

  test('в index.ts ветка QCLOD_ASKPASS_PIPE кончается выходом раньше claimSingleInstance(', () => {
    const src = readFileSync(join(root, 'index.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const branch = code.indexOf("process.env['QCLOD_ASKPASS_PIPE']")
    const client = code.indexOf('runAskpassClient(')
    const exit = code.indexOf('app.exit(', client)
    const lock = code.indexOf('claimSingleInstance(')
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(client)
    expect(client).toBeLessThan(exit)
    expect(exit).toBeLessThan(lock)
    expect(exit).toBeLessThan(code.indexOf("app.setPath('userData'"))
    // The lock is not taken in askpass mode at all.
    expect(code).toMatch(/askpassMode\s*\?\s*false\s*:\s*claimSingleInstance\(/)
  })

  test('обход импортов от askpassClient.ts и askpassEntry.ts не доходит до singleInstance', () => {
    const seen = new Set<string>()
    const walk = (file: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      const text = readFileSync(file, 'utf8')
      expect(text).not.toContain('requestSingleInstanceLock')
      expect(text).not.toMatch(/from 'electron'/)
      for (const m of text.matchAll(/from '(\.[^']+)'/g)) {
        const next = resolve(dirname(file), m[1]!)
        walk(existsSync(next + '.ts') ? next + '.ts' : join(next, 'index.ts'))
      }
    }
    walk(join(root, 'ssh', 'askpassClient.ts'))
    walk(join(root, 'ssh', 'askpassEntry.ts'))
    expect([...seen].some((f) => f.endsWith('singleInstance.ts'))).toBe(false)
  })
})
