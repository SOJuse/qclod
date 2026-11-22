import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AskpassServer, classifyPrompt, promptIsFor } from '@main/ssh/askpass'
import { SshPromptBroker } from '@main/ssh/promptBroker'
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

  test('R6: ключ хоста с отпечатком MD5 или без разобранного типа — other, не «Доверять»', () => {
    const md5 =
      "The authenticity of host 'box (10.0.0.2)' can't be established.\n" +
      'ECDSA key fingerprint is MD5:9f:2a:33:41:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55.\n' +
      'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
    expect(classifyPrompt(md5)).toEqual({ kind: 'other' })
    const noHost = 'ED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no)? '
    expect(classifyPrompt(noHost)).toEqual({ kind: 'other' })
  })
})

describe('promptIsFor (I1)', () => {
  test('тот же хост; пользователь — если цель его называет', () => {
    expect(promptIsFor('demo@test.rebex.net', 'demo@test.rebex.net')).toBe(true)
    expect(promptIsFor('test.rebex.net', 'demo@test.rebex.net')).toBe(true)
    expect(promptIsFor('demo@Test.Rebex.net', 'demo@test.rebex.net')).toBe(true)
    expect(promptIsFor('demo@test.rebex.net', 'root@test.rebex.net')).toBe(false)
    expect(promptIsFor('demo@test.rebex.net', 'demo@bastion')).toBe(false)
    // An alias of ~/.ssh/config says nothing of the real host.
    expect(promptIsFor('myserver', 'demo@test.rebex.net')).toBe(false)
    expect(promptIsFor('demo@[::1]', 'demo@::1')).toBe(true)
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
  remembered: Array<[string, string, string | undefined]>
  answers: Array<(p: SshPrompt) => Omit<SshPromptAnswer, 'promptId'>>
  cancelled: string[]
  /** The stored password as the store has it now (a remembered one replaces it). */
  stored: { value: string | null; for: string | null }
}

const TARGET = 'demo@test.rebex.net'

async function harness(stored: string | null = null, o: { storedFor?: string; ask?: (p: SshPrompt) => Promise<SshPromptAnswer> } = {}): Promise<Harness> {
  const asked: SshPrompt[] = []
  const remembered: Harness['remembered'] = []
  const answers: Harness['answers'] = []
  const cancelled: string[] = []
  const box = { value: stored, for: o.storedFor ?? null }
  server = new AskpassServer({
    platform: process.platform,
    execPath: process.execPath,
    userData,
    ask:
      o.ask ??
      (async (p) => {
        asked.push(p)
        const next = answers.shift()
        return { promptId: p.promptId, ...(next ? next(p) : { ok: false }) } as SshPromptAnswer
      }),
    cancel: (id) => cancelled.push(id),
    storedPassword: () => box.value,
    storedPasswordFor: () => box.for,
    onRemember: (hostId, password, forHost) => {
      remembered.push([hostId, password, forHost])
      box.value = password
      box.for = forHost ?? null
    }
  })
  await server.start()
  return { server, asked, remembered, answers, cancelled, stored: box }
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
    const spawn = h.server.forSpawn('h1', { interactive: false, target: TARGET })
    expect(await askAs(spawn.env, PASSWORD)).toEqual({ code: 0, out: 'stored-pw\n' })
    // A second question in the same try: not interactive — refused, nobody asked.
    expect(await askAs(spawn.env, KBD)).toEqual({ code: 1, out: '' })
    expect(h.asked).toEqual([])
    spawn.done()
  })

  test('второй вопрос пароля в той же попытке идёт человеку', async () => {
    const h = await harness('wrong-pw')
    h.answers.push(() => ({ ok: true, value: 'right-pw', remember: true }))
    const spawn = h.server.forSpawn('h1', { interactive: true, target: TARGET })
    expect((await askAs(spawn.env, PASSWORD)).out).toBe('wrong-pw\n')
    expect(await askAs(spawn.env, PASSWORD)).toEqual({ code: 0, out: 'right-pw\n' })
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]).toMatchObject({ kind: 'password', hostId: 'h1', retry: true, text: 'demo@test.rebex.net' })
    // Kept only once ssh got in with it.
    expect(h.remembered).toEqual([])
    spawn.authed()
    spawn.done()
    expect(h.remembered).toEqual([['h1', 'right-pw', 'demo@test.rebex.net']])
    // A new try: the new one goes first.
    const again = h.server.forSpawn('h1', { interactive: false, target: TARGET })
    expect((await askAs(again.env, PASSWORD)).out).toBe('right-pw\n')
  })

  test('C1: неверный сохранённый пароль при одном вопросе за попытку — фон молчит, человек видит «не подошёл»', async () => {
    const h = await harness('old-pw')
    // A background try (tabs restored at start): one question — the stored one goes, once.
    const first = h.server.forSpawn('h1', { interactive: false, target: TARGET })
    expect(await askAs(first.env, PASSWORD)).toEqual({ code: 0, out: 'old-pw\n' })
    first.done({ authFailed: true })
    expect(h.server.storedRefused('h1')).toBe(true)
    // Every background try after it gets nothing: the server never sees the wrong one again.
    for (let i = 0; i < 3; i++) {
      const bg = h.server.forSpawn('h1', { interactive: false, target: TARGET })
      expect(await askAs(bg.env, PASSWORD)).toEqual({ code: 1, out: '' })
      bg.done({ authFailed: true })
    }
    expect(h.asked).toEqual([])
    // The person presses «Подключить»: asked, with «Пароль не подошёл».
    h.answers.push(() => ({ ok: true, value: 'new-pw', remember: true }))
    const person = h.server.forSpawn('h1', { interactive: true, target: TARGET })
    expect(await askAs(person.env, PASSWORD)).toEqual({ code: 0, out: 'new-pw\n' })
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]).toMatchObject({ kind: 'password', retry: true })
    person.authed()
    person.done()
    expect(h.remembered).toEqual([['h1', 'new-pw', 'demo@test.rebex.net']])
    expect(h.server.storedRefused('h1')).toBe(false)
    const bg = h.server.forSpawn('h1', { interactive: false, target: TARGET })
    expect((await askAs(bg.env, PASSWORD)).out).toBe('new-pw\n')
  })

  test('C1: пароль с «Запомнить» не хранится, если вход с ним не удался', async () => {
    const h = await harness(null)
    h.answers.push(() => ({ ok: true, value: 'typo', remember: true }))
    const spawn = h.server.forSpawn('h1', { interactive: true, target: TARGET })
    expect((await askAs(spawn.env, PASSWORD)).out).toBe('typo\n')
    spawn.done({ authFailed: true })
    expect(h.remembered).toEqual([])
  })

  test('C1: человек вошёл своим паролем без «Запомнить» — сохранённый не подаётся, «не подошёл» больше не пишется', async () => {
    const h = await harness('old-pw')
    const first = h.server.forSpawn('h1', { interactive: false, target: TARGET })
    await askAs(first.env, PASSWORD)
    first.done({ authFailed: true })
    h.answers.push(() => ({ ok: true, value: 'typed' }), () => ({ ok: true, value: 'typed' }))
    const a = h.server.forSpawn('h1', { interactive: true, target: TARGET })
    expect((await askAs(a.env, PASSWORD)).out).toBe('typed\n')
    a.authed()
    a.done()
    const b = h.server.forSpawn('h1', { interactive: true, target: TARGET })
    expect((await askAs(b.env, PASSWORD)).out).toBe('typed\n')
    expect(h.asked.map((p) => (p.kind === 'hostKey' ? null : p.retry))).toEqual([true, false])
  })

  test('I1: пароль не уходит jump-хосту и чужому пользователю; привязка к user@host, для которого его ввели', async () => {
    const h = await harness('target-pw')
    h.answers.push(() => ({ ok: true, value: 'jump-pw' }))
    const spawn = h.server.forSpawn('h1', { interactive: true, target: TARGET })
    // ProxyJump: the first question is the bastion's.
    expect((await askAs(spawn.env, "me@bastion's password: ")).out).toBe('jump-pw\n')
    expect(h.asked[0]).toMatchObject({ kind: 'password', text: 'me@bastion', retry: false })
    expect((await askAs(spawn.env, PASSWORD)).out).toBe('target-pw\n')
    spawn.done()
    // In the background a stranger's question gets nothing.
    const bg = h.server.forSpawn('h1', { interactive: false, target: TARGET })
    expect(await askAs(bg.env, "root@test.rebex.net's password: ")).toEqual({ code: 1, out: '' })
    // A bare «Password:» names nobody: not given either.
    expect(await askAs(bg.env, 'Password: ')).toEqual({ code: 1, out: '' })
    bg.done()

    // An alias of ~/.ssh/config: the stored one goes where it was typed for.
    h.stored.for = 'demo@test.rebex.net'
    const alias = h.server.forSpawn('h1', { interactive: false, target: 'rebex' })
    expect((await askAs(alias.env, PASSWORD)).out).toBe('target-pw\n')
  })

  test('R4: вопрос открыт — asking и onAsking; ssh вышел — вопрос снят (cancel)', async () => {
    const events: boolean[] = []
    let release: ((a: SshPromptAnswer) => void) | null = null
    let seen: SshPrompt | null = null
    const h = await harness(null, {
      ask: (p) =>
        new Promise((resolve) => {
          seen = p
          release = resolve
        })
    })
    const spawn = h.server.forSpawn('h1', { interactive: true, target: TARGET, onAsking: (open) => events.push(open) })
    const pending = askAs(spawn.env, HOST_95)
    await vi.waitFor(() => expect(seen).not.toBeNull())
    expect(spawn.asking()).toBe(true)
    expect(events).toEqual([true])
    spawn.done()
    expect(h.cancelled).toEqual([seen!.promptId])
    release!({ promptId: seen!.promptId, ok: false })
    expect(await pending).toEqual({ code: 1, out: '' })
    expect(events).toEqual([true, false])
    expect(spawn.asking()).toBe(false)
  })

  test('R4: брокер говорит «вопрос снят» по таймауту и отмене, но не после ответа окна', async () => {
    const closed: string[] = []
    const broker = new SshPromptBroker(() => true, 20, (id) => closed.push(id))
    const p = (promptId: string): SshPrompt => ({ promptId, hostId: 'h1', kind: 'other', text: 'x', canRemember: false, retry: false })
    const answered = broker.ask(p('a'))
    expect(broker.answer({ promptId: 'a', ok: true, value: 'v' })).toBe(true)
    expect(await answered).toMatchObject({ ok: true })
    expect(await broker.ask(p('b'))).toEqual({ promptId: 'b', ok: false })
    const cancelled = broker.ask(p('c'))
    broker.cancel('c')
    expect(await cancelled).toEqual({ promptId: 'c', ok: false })
    expect(closed).toEqual(['b', 'c'])
    // Never shown: there is nothing in the window to close.
    const hidden = new SshPromptBroker(() => false, 20, (id) => closed.push(id))
    await hidden.ask(p('d'))
    expect(closed).toEqual(['b', 'c'])
  })

  test('C2: папка userData/ssh есть до первого запуска ssh (на любой платформе)', async () => {
    await harness()
    expect(existsSync(join(userData, 'ssh'))).toBe(true)
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

  test('I8: текст вопроса, разбитый на аргументы (" --inspect=), не уходит никуда', async () => {
    const h = await harness('pw')
    const spawn = h.server.forSpawn('h1', { interactive: true, target: TARGET })
    // The server wrote quotes into its keyboard-interactive prompt; a command line split it.
    const split = ['(demo@test.rebex.net) Code "', '--inspect=0.0.0.0:9229', '" ']
    let out = ''
    expect(await runAskpassClient(split, spawn.env, (s) => (out += s))).toBe(1)
    expect(out).toBe('')
    expect(h.asked).toEqual([])
    // Whole, the same text is one question as it is.
    h.answers.push(() => ({ ok: true, value: 'x' }))
    await askAs(spawn.env, split.join(''))
    expect(h.asked[0]).toMatchObject({ kind: 'other', text: split.join('') })
  })

  test('env для ssh и askpass.sh', async () => {
    const h = await harness()
    const spawn = h.server.forSpawn('h1', { interactive: true })
    expect(spawn.env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' })
    if (process.platform !== 'win32') {
      // Written once, in start(): a run does not write it again.
      rmSync(join(userData, 'ssh', 'askpass.sh'))
      h.server.forSpawn('h1', { interactive: true })
      expect(existsSync(join(userData, 'ssh', 'askpass.sh'))).toBe(false)
    }
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
