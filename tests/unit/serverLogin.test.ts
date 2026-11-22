import { describe, expect, test, vi } from 'vitest'
import { ServerLogin, findLoginUrl, loginOutcome, type IPtyLike, type LoginProgressEvent } from '@main/ssh/serverLogin'
import type { ServerAuth } from '@shared/relayProtocol'

// What `claude auth login` prints under a terminal, colours included.
const SAMPLE =
  '\x1b[?25l\x1b[2J\x1b[H\x1b[1mWelcome to Claude Code\x1b[22m\r\n' +
  "Browser didn't open? Use the url below to sign in:\r\n\r\n" +
  '\x1b[36mhttps://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=user%3Ainference\x1b[39m\r\n\r\n' +
  'Paste code here if prompted > '

function fakePty() {
  let data: ((d: string) => void) | null = null
  let exit: ((e: { exitCode: number }) => void) | null = null
  const written: string[] = []
  const pty: IPtyLike & { emit(d: string): void; end(code: number): void; written: string[]; killed: boolean } = {
    written,
    killed: false,
    onData: (cb) => void (data = cb),
    onExit: (cb) => void (exit = cb),
    write: (d) => void written.push(d),
    kill: () => void (pty.killed = true),
    emit: (d) => data?.(d),
    end: (code) => exit?.({ exitCode: code })
  }
  return pty
}

function login(recheck: () => Promise<ServerAuth>) {
  const pty = fakePty()
  const progress: LoginProgressEvent[] = []
  const spawned: Array<{ file: string; args: string[] }> = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const l = new ServerLogin({
    spawnPty: (file, args) => {
      spawned.push({ file, args })
      return pty
    },
    onProgress: (p) => progress.push(p),
    recheck,
    sshPath: 'ssh',
    platform: 'linux',
    userData: '/u',
    uid: 1000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => undefined
  })
  return { l, pty, progress, spawned, timers }
}

describe('вход в Claude на сервере', () => {
  test('findLoginUrl на образце с ANSI; http: не принимается; чужой хост — тоже', () => {
    expect(findLoginUrl(SAMPLE)).toBe(
      'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=user%3Ainference'
    )
    expect(findLoginUrl('go to http://claude.ai/oauth/authorize?x=1')).toBeNull()
    expect(findLoginUrl('https://evil.example/claude.ai')).toBeNull()
    expect(findLoginUrl('https://console.anthropic.com/oauth/code/callback?x=1')).toBe(
      'https://console.anthropic.com/oauth/code/callback?x=1'
    )
  })

  test('loginOutcome', () => {
    expect(loginOutcome('\x1b[32mLogin successful.\x1b[0m')).toBe('ok')
    expect(loginOutcome('OAuth error: invalid_grant')).toBe('failed')
    expect(loginOutcome(SAMPLE)).toBeNull()
  })

  test('ssh -tt … -- claude auth login; ссылка — waitingCode; sendCode пишет код\\r', () => {
    const t = login(async () => ({ loggedIn: false, claudePath: '/c', claudeVersion: null }))
    t.l.start({ target: 'me@box' }, '/home/me/.local/bin/claude', { SSH_ASKPASS: '/a' })
    expect(t.spawned[0]!.args[0]).toBe('-tt')
    expect(t.spawned[0]!.args.slice(-2)).toEqual(['--', "'/home/me/.local/bin/claude' 'auth' 'login'"])
    t.pty.emit(SAMPLE)
    expect(t.progress.map((p) => p.state)).toEqual(['starting', 'waitingCode'])
    expect(t.progress[1]!.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/)
    t.l.sendCode('abc-123#xyz')
    expect(t.pty.written).toEqual(['abc-123#xyz\r'])
    expect(t.progress.at(-1)!.state).toBe('checking')
  })

  test('после done повторная проверка вызвана, и вход подтверждён ею', async () => {
    const recheck = vi.fn(async (): Promise<ServerAuth> => ({ loggedIn: true, email: 'me@x.io', plan: 'Max', claudePath: '/c', claudeVersion: '2.1.317' }))
    const t = login(recheck)
    t.l.start({ target: 'me@box' }, 'claude', {})
    t.pty.emit(SAMPLE)
    t.l.sendCode('code')
    t.pty.emit('\r\nLogin successful. Logged in as me@x.io\r\n')
    await vi.waitFor(() => expect(t.progress.at(-1)!.state).toBe('done'))
    expect(recheck).toHaveBeenCalled()
    expect(t.progress.at(-1)).toEqual({ state: 'done', email: 'me@x.io' })
    expect(t.pty.killed).toBe(true)
  })

  test('CLI вышел, а вход не подтвердился — failed с его строкой', async () => {
    const t = login(async () => ({ loggedIn: false, claudePath: '/c', claudeVersion: null }))
    t.l.start({ target: 'me@box' }, 'claude', {})
    t.pty.emit('Something went wrong\r\n')
    t.pty.end(1)
    await vi.waitFor(() => expect(t.progress.at(-1)!.state).toBe('failed'))
    expect(t.progress.at(-1)!.error).toBe('Something went wrong')
  })
})
