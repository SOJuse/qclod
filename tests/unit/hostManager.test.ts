import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  CLOSING_FILE,
  HostManager,
  INSTALLING_TEXT,
  QUIET_CHECKLIST_MS,
  hostKeyChangedText,
  NOT_LOGGED_IN_TEXT,
  RELAY_PROTO_TEXT,
  lingerText,
  type RelayLink,
  type SshRunner
} from '@main/ssh/hostManager'
import { HostStore } from '@main/ssh/hostStore'
import type { SecretBox } from '@main/ssh/secretBox'
import { RelayCallError } from '@main/ssh/relayClient'
import type { AskpassServer } from '@main/ssh/askpass'
import type { RelayManifest } from '@main/ssh/relayInstaller'
import type { ConnectStep, TabServer } from '@shared/types'

const box: SecretBox = { available: () => true, seal: (s) => `S:${s}`, open: (s) => s.slice(2) }

function probeOut(over: Record<string, string> = {}): string {
  const kv = {
    os: 'Linux',
    arch: 'x86_64',
    libc: 'glibc',
    home: '/home/me',
    user: 'me',
    shell: '/bin/bash',
    claudePath: '/home/me/.local/bin/claude',
    claudeVersion: '2.1.317 (Claude Code)',
    relayVersion: 'qclod-relay 1.0.0',
    systemdUser: '1',
    linger: 'yes',
    tmux: '1',
    gzip: '1',
    ...over
  }
  return ['motd', '__QCLOD_PROBE_BEGIN__', ...Object.entries(kv).map(([k, v]) => `${k}=${v}`), '__QCLOD_PROBE_END__'].join('\n')
}

interface FakeLink extends RelayLink {
  calls: Array<{ m: string; p: unknown }>
  connectError?: Error
  answers: Record<string, unknown>
  connects: number
  closed: number
  callError?: Record<string, Error>
  /** The state the channel says it is in, as RelayClient would. */
  become(s: RelayLink['state']): void
}

function fakeLink(): FakeLink {
  let state: RelayLink['state'] = 'idle'
  const listeners = new Set<(s: RelayLink['state']) => void>()
  const link: FakeLink = {
    calls: [],
    connects: 0,
    closed: 0,
    become: (s) => {
      state = s
      for (const l of listeners) l(state)
    },
    answers: {
      'host.info': { hostname: 'box', user: 'me', home: '/home/me', arch: 'x64', relay: '1.0.0', supervisor: 'systemd', linger: 'yes' },
      'auth.status': { loggedIn: true, email: 'me@x.io', plan: 'Max', claudePath: '/c', claudeVersion: '2.1.317' },
      'relay.restart': { scheduled: true, busy: 0 }
    },
    get state() {
      return state
    },
    connect: async () => {
      link.connects++
      if (link.connectError) throw link.connectError
      state = 'online'
      for (const l of listeners) l(state)
      return { proto: 1, relay: '1.0.0', binary: '1.0.0' }
    },
    call: async <T,>(m: string, p: unknown) => {
      link.calls.push({ m, p })
      const err = link.callError?.[m]
      if (err) throw err
      return link.answers[m] as T
    },
    onState: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    close: () => {
      link.closed++
      state = 'idle'
    }
  }
  return link
}

const GZ = gzipSync(Buffer.from('relay elf'))
function manifest(version = '1.0.0'): RelayManifest {
  const sha = createHash('sha256').update(GZ).digest('hex')
  return {
    version,
    assets: {
      x64: { name: `qclod-relay-${version}-linux-x64.gz`, sha256: sha, size: GZ.length },
      arm64: { name: `qclod-relay-${version}-linux-arm64.gz`, sha256: sha, size: GZ.length }
    }
  }
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qclod-hm-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(
  opts: { probe?: string; manifest?: RelayManifest; link?: FakeLink; probeCode?: number; probeErr?: string; now?: () => number } = {}
) {
  const store = new HostStore(dir, box)
  const entry = store.save({ label: 'Дом', target: 'me@box', auth: 'key', fromConfig: false })
  const runs: Array<{ remote: string; stdin?: Buffer | string }> = []
  const run: SshRunner = vi.fn(async (_t, remote, o) => {
    runs.push({ remote, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}) })
    if (remote === "'sh' '-s'") return { code: opts.probeCode ?? 0, stdout: opts.probe ?? probeOut(), stderr: opts.probeErr ?? '' }
    return { code: 0, stdout: '', stderr: '' }
  })
  const progress: ConnectStep[][] = []
  const link = opts.link ?? fakeLink()
  const opened: Array<[string, TabServer]> = []
  const hm = new HostManager({
    store,
    askpass: {} as AskpassServer,
    userData: dir,
    appVersion: '1.0.0',
    manifest: opts.manifest ?? manifest(),
    onChanged: () => undefined,
    onProgress: (_id, steps) => progress.push(steps),
    openTab: (cwd, server) => {
      opened.push([cwd, server])
      return { id: 't1', cwd, title: cwd, overrides: {}, server } as never
    },
    rules: () => [{ id: 'r1', toolName: 'Bash', behavior: 'allow' }],
    autoAnswerMs: () => 300000,
    makeClient: () => link,
    run,
    ...(opts.now ? { now: opts.now } : {})
  })
  const probes = () => runs.filter((r) => r.remote === "'sh' '-s'").length
  return { hm, store, entry, runs, progress, link, opened, probes, last: () => progress.at(-1)! }
}

describe('HostManager.connect', () => {
  test('порядок шагов и всё зелёное; rules.sync и autonomy.settings после связи', async () => {
    const s = setup()
    expect(await s.hm.connect(s.entry.id, true)).toBe(true)
    expect(s.last().map((x) => x.id)).toEqual(['ssh', 'auth', 'claude', 'relay', 'login'])
    expect(s.last().map((x) => x.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(s.last().map((x) => x.text)).toEqual([
      'Связь с сервером',
      'Вход',
      'Claude Code 2.1.317',
      'Посредник Qclod 1.0.0',
      'me@x.io · Max'
    ])
    expect(s.link.calls.map((c) => c.m)).toEqual(['host.info', 'auth.status', 'rules.sync', 'autonomy.settings'])
    expect(s.link.calls[3]!.p).toEqual({ autoAnswerMs: 300000 })
    expect(s.hm.list()[0]).toMatchObject({ state: 'online', account: { email: 'me@x.io' } })
    // The relay was there already: nothing installed.
    expect(s.runs.map((r) => r.remote)).toEqual(["'sh' '-s'"])
  })

  test('claude не найден — fail и посредник не ставится', async () => {
    const s = setup({ probe: probeOut({ claudePath: '', claudeVersion: '', relayVersion: '' }) })
    expect(await s.hm.connect(s.entry.id, true)).toBe(false)
    const claude = s.last().find((x) => x.id === 'claude')!
    expect(claude.state).toBe('fail')
    expect(claude.text).toContain('Claude Code на сервере не найден')
    expect(s.last().find((x) => x.id === 'relay')!.state).toBe('pending')
    expect(s.runs).toHaveLength(1)
    expect(s.link.calls).toEqual([])
  })

  test('нет посредника — ставится из userData/relay, потом setup', async () => {
    mkdirSync(join(dir, 'relay'))
    writeFileSync(join(dir, 'relay', 'qclod-relay-1.0.0-linux-x64.gz'), GZ)
    const s = setup({ probe: probeOut({ relayVersion: '', gzip: '0' }) })
    expect(await s.hm.connect(s.entry.id, true)).toBe(true)
    expect(s.progress.some((p) => p.find((x) => x.id === 'relay')!.text === INSTALLING_TEXT)).toBe(true)
    expect(s.runs.map((r) => r.remote)).toEqual([
      "'sh' '-s'",
      expect.stringMatching(/^'sh' '-c' 'set -e/),
      "~/'.qclod/bin/qclod-relay' 'setup'"
    ])
    // No gzip there: Qclod unpacks it itself.
    expect(Buffer.from(s.runs[1]!.stdin as Buffer).toString()).toBe('relay elf')
  })

  test('linger no — warn с текстом', async () => {
    const link = fakeLink()
    link.answers['host.info'] = { ...(link.answers['host.info'] as object), linger: 'no' }
    const s = setup({ link })
    await s.hm.connect(s.entry.id, true)
    expect(s.last().find((x) => x.id === 'relay')).toMatchObject({
      state: 'warn',
      hint: 'Агент может остановиться, когда вы выйдете из ssh. Чтобы он жил всегда, выполните на сервере один раз: sudo loginctl enable-linger me'
    })
    expect(lingerText('me')).toContain('enable-linger me')
  })

  test('не вошёл в Claude — warn', async () => {
    const link = fakeLink()
    link.answers['auth.status'] = { loggedIn: false, claudePath: '/c', claudeVersion: '2.1.317' }
    const s = setup({ link })
    expect(await s.hm.connect(s.entry.id, true)).toBe(true)
    expect(s.last().find((x) => x.id === 'login')).toMatchObject({ state: 'warn', text: NOT_LOGGED_IN_TEXT })
  })

  test('proto — relayUpdate: required, сессии не открываются', async () => {
    const link = fakeLink()
    link.connectError = new RelayCallError('proto', 'proto 2')
    const s = setup({ link })
    expect(await s.hm.connect(s.entry.id, true)).toBe(false)
    expect(s.hm.list()[0]).toMatchObject({ relayUpdate: 'required', state: 'error', problem: RELAY_PROTO_TEXT })
    await expect(s.hm.client(s.entry.id)).rejects.toThrow(RELAY_PROTO_TEXT)
  })

  test('старая версия посредника — обновление и restart idle; занят — «обновится позже»', async () => {
    mkdirSync(join(dir, 'relay'))
    const m = manifest('1.0.1')
    writeFileSync(join(dir, 'relay', m.assets.x64.name), GZ)
    const link = fakeLink()
    link.answers['relay.restart'] = { scheduled: true, busy: 2 }
    const s = setup({ manifest: m, link })
    expect(await s.hm.connect(s.entry.id, true)).toBe(true)
    expect(link.calls.find((c) => c.m === 'relay.restart')!.p).toEqual({ when: 'idle' })
    expect(s.last().find((x) => x.id === 'relay')).toMatchObject({
      state: 'warn',
      hint: 'Посредник обновится, когда агенты на сервере закончат работу'
    })
    expect(s.hm.list()[0]!.relayUpdate).toBe('pending')
  })

  test('сменился ключ хоста — hostKeyChanged с текстом про ssh-keygen -R', async () => {
    const s = setup({ probeCode: 255, probeErr: '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.' })
    expect(await s.hm.connect(s.entry.id, true)).toBe(false)
    const view = s.hm.list()[0]!
    expect(view.state).toBe('hostKeyChanged')
    expect(view.problem).toContain('Ключ сервера box изменился.')
    expect(view.problem).toContain(`ssh-keygen -R box -f "${join(dir, 'ssh', 'known_hosts')}"`)
  })

  test('неверный пароль — needsAuth', async () => {
    const s = setup({ probeCode: 255, probeErr: 'me@box: Permission denied (password).' })
    expect(await s.hm.connect(s.entry.id, true)).toBe(false)
    expect(s.hm.list()[0]!.state).toBe('needsAuth')
    expect(s.last().find((x) => x.id === 'auth')!.state).toBe('fail')
  })

  test('C1: client() при needsAuth не запускает ни ssh, ни чек-лист — ждёт человека', async () => {
    const s = setup({ probeCode: 255, probeErr: 'me@box: Permission denied (password).' })
    expect(await s.hm.connect(s.entry.id, false)).toBe(false)
    expect(s.probes()).toBe(1)
    // Every call of the window — tabs, files, @-list, history — gets the reason, and no ssh.
    for (let i = 0; i < 5; i++) await expect(s.hm.client(s.entry.id)).rejects.toThrow()
    expect(s.probes()).toBe(1)
    // «Подключить»: the person is there — one more try.
    await s.hm.connect(s.entry.id, true)
    expect(s.probes()).toBe(2)
  })

  test('C1: client() при hostKeyChanged — тоже ни одной попытки', async () => {
    const s = setup({ probeCode: 255, probeErr: 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!' })
    await s.hm.connect(s.entry.id, false)
    await expect(s.hm.client(s.entry.id)).rejects.toThrow(/изменился/)
    expect(s.probes()).toBe(1)
  })

  test('I2: канал есть, но переподключается — client() сразу отказывает, паузы ведёт RelayClient', async () => {
    const s = setup()
    expect(await s.hm.connect(s.entry.id, true)).toBe(true)
    expect(s.link.connects).toBe(1)
    s.link.become('reconnecting')
    for (let i = 0; i < 5; i++) await expect(s.hm.client(s.entry.id)).rejects.toThrow('Сервер не на связи')
    expect(s.link.connects).toBe(1)
    expect(s.probes()).toBe(1)
    s.link.become('online')
    expect(await s.hm.client(s.entry.id)).toBe(s.link)
  })

  test('I2: без канала тихий чек-лист — не чаще раза в минуту, одновременные вызовы — один', async () => {
    let now = 1_000_000
    const s = setup({ probeCode: 255, probeErr: 'ssh: connect to host box port 22: Connection timed out', now: () => now })
    await Promise.all([1, 2, 3].map(() => s.hm.client(s.entry.id).catch(() => undefined)))
    expect(s.probes()).toBe(1)
    now += QUIET_CHECKLIST_MS - 1
    await expect(s.hm.client(s.entry.id)).rejects.toThrow()
    expect(s.probes()).toBe(1)
    now += 2
    await expect(s.hm.client(s.entry.id)).rejects.toThrow()
    expect(s.probes()).toBe(2)
  })

  test('I6: «закрыть» без связи хранится в userData и уходит при следующей связи', async () => {
    const s = setup()
    s.hm.closeLater(s.entry.id, 'sess-1')
    s.hm.closeLater(s.entry.id, 'sess-2')
    expect(JSON.parse(readFileSync(join(dir, CLOSING_FILE), 'utf8')).hosts[s.entry.id]).toEqual(['sess-1', 'sess-2'])
    // Qclod restarted meanwhile: the list is read back.
    const again = setup({ link: s.link })
    expect(again.hm.pendingCloses(s.entry.id)).toEqual(['sess-1', 'sess-2'])
    // setup() saved a second server; the list is the first one's.
    const hm = again.hm
    s.link.callError = { 'session.close': new RelayCallError('offline', 'нет связи') }
    expect(await s.hm.connect(s.entry.id, true)).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(s.hm.pendingCloses(s.entry.id)).toEqual(['sess-1', 'sess-2'])
    delete s.link.callError
    s.link.become('reconnecting')
    s.link.become('online')
    await vi.waitFor(() => expect(s.hm.pendingCloses(s.entry.id)).toEqual([]))
    expect(s.link.calls.filter((c) => c.m === 'session.close').map((c) => c.p)).toEqual([
      { s: 'sess-1' },
      { s: 'sess-1' },
      { s: 'sess-2' }
    ])
    expect(JSON.parse(readFileSync(join(dir, CLOSING_FILE), 'utf8')).hosts).toEqual({})
    void hm
  })

  test('save с другим хостом закрывает старый канал', async () => {
    const s = setup()
    await s.hm.connect(s.entry.id, true)
    s.hm.save({ id: s.entry.id, label: 'Дом', target: 'me@box', auth: 'key', fromConfig: false })
    expect(s.link.closed).toBe(0)
    s.hm.save({ id: s.entry.id, label: 'Дом', target: 'me@box', port: 2222, auth: 'key', fromConfig: false })
    expect(s.link.closed).toBe(1)
    expect(s.hm.existingClient(s.entry.id)).toBeNull()
  })

  test('совет при смене ключа: порт не 22 — [host]:port, и обе команды', () => {
    const text = hostKeyChangedText('box', dir, 2222)
    expect(text).toContain(`ssh-keygen -R "[box]:2222" -f "${join(dir, 'ssh', 'known_hosts')}"`)
    expect(text).toMatch(/~\/\.ssh\/known_hosts, ещё ssh-keygen -R "\[box\]:2222"$/)
    expect(hostKeyChangedText('box', dir, 22)).toContain('ssh-keygen -R box -f')
  })

  test('openFolder кладёт путь в недавние и открывает вкладку с server.hostId', async () => {
    const s = setup()
    const tab = s.hm.openFolder(s.entry.id, '/home/me/app')
    expect(tab.server).toEqual({ hostId: s.entry.id })
    expect(s.store.list()[0]!.recent).toEqual(['/home/me/app'])
  })
})
