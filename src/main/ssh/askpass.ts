/**
 * Every question ssh asks — a new host key, a password, a key's passphrase,
 * a keyboard-interactive prompt — comes here through askpass (decision 5)
 * and goes to the window, or is answered or refused by the rules below.
 *
 * One `forSpawn` per ssh run: its token is good for that run only. A stored
 * password goes only to the user@host it is for (I1), once per run. When it
 * does not fit — ssh asks again in the same run, or the run ends «Permission
 * denied» — it is not given again (Review Focus 4, C1): the next run a person
 * is at the window asks them with «Пароль не подошёл»; runs nobody is waiting
 * for get nothing at all, so the server never sees the wrong one twice. A
 * typed password is kept only once ssh got in with it.
 *
 * A password travels only through the pipe and the client's stdout; the log
 * gets the kind of question, never the answer.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { SshPrompt, SshPromptAnswer } from '../../shared/types'
import { controlDir, ensurePrivateDir, shq, type PrivateDirFs } from './sshArgs'

export type PromptKind = 'hostKey' | 'password' | 'passphrase' | 'other'

export interface ClassifiedPrompt {
  kind: PromptKind
  /** hostKey: the host; password: user@host. */
  host?: string
  keyType?: string
  fingerprint?: string
  /** passphrase: the key's file. */
  keyPath?: string
}

/**
 * The lines are the probe's (task 7): OpenSSH 9.5 and 10.2 differ in the
 * fingerprint line. A host-key question whose host, type or SHA256 print is
 * not read (FingerprintHash md5, another wording) is `other` (R6): the person
 * sees ssh's own text, never a «Доверять» for a key nobody was shown.
 */
export function classifyPrompt(text: string): ClassifiedPrompt {
  if (/continue connecting \(yes\/no(\/\[fingerprint\])?\)\?/.test(text)) {
    const host = /^The authenticity of host '([^']*)'/m.exec(text)?.[1]
    const key = /^(\S+) key fingerprint is:? (SHA256:[A-Za-z0-9+/=]+)\.?[ \t\r]*$/m.exec(text)
    if (!host || !key) return { kind: 'other' }
    return { kind: 'hostKey', host: host.replace(/ \(.*\)$/, ''), keyType: key[1]!, fingerprint: key[2]! }
  }
  const line = text.trim()
  const passphrase = /^Enter passphrase for key '(.*)':$/.exec(line)
  if (passphrase) return { kind: 'passphrase', keyPath: passphrase[1]! }
  const classic = /^(\S+)'s password:$/i.exec(line)
  if (classic) return { kind: 'password', host: classic[1]! }
  const kbd = /^\(([^)\s]+)\) Password:$/i.exec(line)
  if (kbd) return { kind: 'password', host: kbd[1]! }
  if (/(^|\s)password:$/i.test(line)) return { kind: 'password' }
  return { kind: 'other' }
}

function splitUserHost(s: string): { user: string | null; host: string } {
  const at = s.lastIndexOf('@')
  const host = (at >= 0 ? s.slice(at + 1) : s).replace(/^\[(.*)\]$/, '$1').toLowerCase()
  return { user: at >= 0 ? s.slice(0, at) : null, host }
}

/**
 * Whether ssh's «user@host's password» is the server's own (I1): the same
 * host, and the same user when the target names one. An alias of
 * ~/.ssh/config matches nothing here — until askpass learns the user@host the
 * person typed the kept password for.
 */
export function promptIsFor(target: string, promptHost: string): boolean {
  const t = splitUserHost(target)
  const p = splitUserHost(promptHost)
  if (p.user === null || t.host !== p.host) return false
  return t.user === null || t.user === p.user
}

export interface AskpassSpawn {
  env: Record<string, string>
  /** ssh got in: a password typed with «Запомнить» is kept now (and only now). */
  authed(): void
  /** ssh has exited; `authFailed` — it said «Permission denied». */
  done(o?: { authFailed?: boolean }): void
  /** A question of this run is with the person right now. */
  asking(): boolean
}

export interface AskpassDeps {
  platform: NodeJS.Platform
  execPath: string
  userData: string
  ask: (p: SshPrompt) => Promise<SshPromptAnswer>
  /** A question that went to the window and is not answered there — ssh is gone, the question void (R4). */
  cancel?: (promptId: string) => void
  storedPassword: (hostId: string) => string | null
  /** The user@host the stored password was typed for, when askpass learnt it. */
  storedPasswordFor?: (hostId: string) => string | null
  onRemember: (hostId: string, password: string, forHost?: string) => void
  /** Whether «Запомнить» can be offered (safeStorage works). */
  canRemember?: () => boolean
  /** out/main/askpass.js, for the POSIX wrapper. */
  askpassScript?: string
  uid?: number
  /** Tests: the checks of the /tmp folder. */
  dirFs?: PrivateDirFs
  log?: (line: string) => void
}

interface SpawnState {
  hostId: string
  interactive: boolean
  target: string | null
  /** The stored password given in this run, if it was. */
  storedGiven: string | null
  /** A password question of this run went to the person. */
  typed: boolean
  /** Password questions of this run, by the user@host they named. */
  asked: Map<string, number>
  remember: { password: string; forHost?: string } | null
  authOk: boolean
  open: Set<string>
  onAsking?: (open: boolean) => void
}

const MAX_REQUEST_BYTES = 64 * 1024

type Reply = { ok: true; value: string } | { ok: false }

function digest(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

export class AskpassServer {
  private server: Server | null = null
  private pipePath = ''
  private scriptPath = ''
  private readonly spawns = new Map<string, SpawnState>()
  /** By server: the digest of a stored password the server refused (C1). Gone with a new one. */
  private readonly refused = new Map<string, { digest: string; told: boolean }>()

  constructor(private readonly deps: AskpassDeps) {}

  get path(): string {
    return this.pipePath
  }

  /** Whether the stored password of `hostId` was refused and is not given any more. */
  storedRefused(hostId: string): boolean {
    const stored = this.deps.storedPassword(hostId)
    return stored !== null && this.refused.get(hostId)?.digest === digest(stored)
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve()
    // ssh does not make the folder of UserKnownHostsFile (C2): without it no host key is ever kept.
    mkdirSync(join(this.deps.userData, 'ssh'), { recursive: true })
    const rand = randomBytes(8).toString('hex')
    if (this.deps.platform === 'win32') {
      this.pipePath = `\\\\.\\pipe\\qclod-askpass-${rand}`
    } else {
      const uid = this.deps.uid ?? process.getuid?.() ?? 0
      const dir = controlDir(uid)
      try {
        ensurePrivateDir(dir, uid, this.deps.dirFs)
      } catch (err) {
        return Promise.reject(err)
      }
      this.pipePath = join(dir, `askpass-${rand}.sock`)
      this.scriptPath = this.writeAskpassScript()
    }
    const server = createServer((socket) => this.serve(socket))
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.pipePath, () => {
        server.off('error', reject)
        if (this.deps.platform !== 'win32') {
          try {
            chmodSync(this.pipePath, 0o600)
          } catch {
            // The folder is 0700 already.
          }
        }
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.spawns.clear()
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      server.close(() => {
        if (this.deps.platform !== 'win32') rmSync(this.pipePath, { force: true })
        resolve()
      })
    })
  }

  /** The POSIX wrapper ssh runs as SSH_ASKPASS: no Dock icon (ELECTRON_RUN_AS_NODE). Written once, in start(). */
  writeAskpassScript(): string {
    const dir = join(this.deps.userData, 'ssh')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'askpass.sh')
    const script = this.deps.askpassScript ?? join(__dirname, 'askpass.js')
    const body = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shq(this.deps.execPath)} ${shq(script)} "$@"\n`
    writeFileSync(file, body, { encoding: 'utf8', mode: 0o700 })
    try {
      chmodSync(file, 0o700)
    } catch {
      // Windows has no modes.
    }
    return file
  }

  /**
   * The env one ssh run gets; `done()` when it has exited. `target` — the
   * server's user@host as ssh is given it: the stored password goes only there.
   * `onAsking` — a question of this run opened (true) or closed (false).
   */
  forSpawn(
    hostId: string,
    o: { interactive: boolean; target?: string; onAsking?: (open: boolean) => void }
  ): AskpassSpawn {
    const token = randomBytes(24).toString('hex')
    const state: SpawnState = {
      hostId,
      interactive: o.interactive,
      target: o.target ?? null,
      storedGiven: null,
      typed: false,
      asked: new Map(),
      remember: null,
      authOk: false,
      open: new Set(),
      ...(o.onAsking ? { onAsking: o.onAsking } : {})
    }
    this.spawns.set(token, state)
    const askpass =
      this.deps.platform === 'win32' ? this.deps.execPath : this.scriptPath || (this.scriptPath = this.writeAskpassScript())
    return {
      env: {
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: ':0',
        QCLOD_ASKPASS_PIPE: this.pipePath,
        QCLOD_ASKPASS_TOKEN: token
      },
      authed: () => {
        if (state.authOk) return
        state.authOk = true
        // The stored one went through: whatever was said of it before is over.
        if (state.storedGiven !== null && !state.typed) this.refused.delete(hostId)
        // The person got in with a password of their own: «не подошёл» has been said.
        const r = this.refused.get(hostId)
        if (state.typed && r) r.told = true
        this.commitRemember(state)
      },
      done: (d) => {
        if (this.spawns.get(token) !== state) return
        this.spawns.delete(token)
        if (d?.authFailed && state.storedGiven !== null && !state.typed) this.refuse(state)
        // A question still open has nobody to answer for any more.
        for (const promptId of [...state.open]) this.deps.cancel?.(promptId)
        state.remember = null
      },
      asking: () => state.open.size > 0
    }
  }

  private refuse(state: SpawnState): void {
    if (state.storedGiven === null) return
    this.refused.set(state.hostId, { digest: digest(state.storedGiven), told: false })
    this.deps.log?.('askpass: сохранённый пароль не подошёл')
  }

  private commitRemember(state: SpawnState): void {
    const r = state.remember
    state.remember = null
    if (r) this.deps.onRemember(state.hostId, r.password, r.forHost)
  }

  /** Whether the stored password may be given to this question. */
  private storedFits(state: SpawnState, promptHost: string | undefined): boolean {
    if (!promptHost) return false
    const bound = this.deps.storedPasswordFor?.(state.hostId) ?? null
    if (bound) return promptIsFor(bound, promptHost)
    return state.target !== null && promptIsFor(state.target, promptHost)
  }

  private serve(socket: Socket): void {
    let buffer = ''
    let handled = false
    let replied = false
    let cancelOpen: (() => void) | null = null
    socket.setEncoding('utf8')
    const reply = (r: Reply): void => {
      replied = true
      if (!socket.destroyed) socket.end(JSON.stringify(r) + '\n')
    }
    socket.on('data', (chunk: string) => {
      if (handled) return
      buffer += chunk
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true
        return reply({ ok: false })
      }
      const end = buffer.indexOf('\n')
      if (end < 0) return
      handled = true
      let req: unknown
      try {
        req = JSON.parse(buffer.slice(0, end))
      } catch {
        return reply({ ok: false })
      }
      const { token, prompt } = (req ?? {}) as { token?: unknown; prompt?: unknown }
      if (typeof token !== 'string' || typeof prompt !== 'string') return reply({ ok: false })
      this.answer(token, prompt, (cancel) => {
        cancelOpen = cancel
      }).then(reply, () => reply({ ok: false }))
    })
    // The askpass process went away (ssh gave up, timed out): its question is void.
    socket.on('close', () => {
      if (!replied) cancelOpen?.()
    })
    socket.on('error', () => socket.destroy())
  }

  /** One question to the person; it counts as open (R4) until answered or void. */
  private async askPerson(state: SpawnState, p: SshPrompt, onOpen: (cancel: () => void) => void): Promise<SshPromptAnswer> {
    state.open.add(p.promptId)
    state.onAsking?.(true)
    onOpen(() => this.deps.cancel?.(p.promptId))
    try {
      return await this.deps.ask(p)
    } finally {
      state.open.delete(p.promptId)
      state.onAsking?.(false)
    }
  }

  private async answer(token: string, prompt: string, onOpen: (cancel: () => void) => void): Promise<Reply> {
    const spawn = this.spawns.get(token)
    if (!spawn) return { ok: false }
    const c = classifyPrompt(prompt)
    this.deps.log?.(`askpass: ${c.kind}${spawn.interactive ? '' : ' (фон)'}`)
    const promptId = randomBytes(8).toString('hex')

    if (c.kind === 'password') {
      const key = c.host ?? prompt
      const before = spawn.asked.get(key) ?? 0
      spawn.asked.set(key, before + 1)
      // ssh asks the same user@host again in this run: the last answer did not fit.
      if (before > 0 && spawn.storedGiven !== null && !spawn.typed) this.refuse(spawn)
      const stored = this.deps.storedPassword(spawn.hostId)
      const mark = this.refused.get(spawn.hostId)
      const refused = stored !== null && mark?.digest === digest(stored)
      const fits = stored !== null && this.storedFits(spawn, c.host)
      if (spawn.storedGiven === null && stored !== null && !refused && fits) {
        spawn.storedGiven = stored
        return { ok: true, value: stored }
      }
      if (!spawn.interactive) return { ok: false }
      const a = await this.askPerson(
        spawn,
        {
          promptId,
          hostId: spawn.hostId,
          kind: 'password',
          text: c.host ?? prompt,
          canRemember: this.deps.canRemember?.() ?? true,
          retry: before > 0 || (refused && fits && mark?.told !== true)
        },
        onOpen
      )
      if (!a.ok || a.promptId !== promptId || this.spawns.get(token) !== spawn) return { ok: false }
      spawn.typed = true
      if (a.remember) {
        spawn.remember = { password: a.value, ...(c.host ? { forHost: c.host } : {}) }
        if (spawn.authOk) this.commitRemember(spawn)
      }
      return { ok: true, value: a.value }
    }

    if (!spawn.interactive) return { ok: false }
    let p: SshPrompt
    if (c.kind === 'hostKey') {
      p = {
        promptId,
        hostId: spawn.hostId,
        kind: 'hostKey',
        host: c.host ?? '',
        keyType: c.keyType ?? '',
        fingerprint: c.fingerprint ?? ''
      }
    } else {
      p = {
        promptId,
        hostId: spawn.hostId,
        kind: c.kind,
        text: c.kind === 'passphrase' ? c.keyPath ?? prompt : prompt,
        canRemember: false,
        retry: false
      }
    }
    const a = await this.askPerson(spawn, p, onOpen)
    if (!a.ok || a.promptId !== promptId || this.spawns.get(token) !== spawn) return { ok: false }
    return { ok: true, value: c.kind === 'hostKey' ? 'yes' : a.value }
  }
}
