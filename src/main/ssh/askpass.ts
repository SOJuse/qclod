/**
 * Every question ssh asks — a new host key, a password, a key's passphrase,
 * a keyboard-interactive prompt — comes here through askpass (decision 5)
 * and goes to the window, or is answered or refused by the rules below.
 *
 * One `forSpawn` per ssh run: its token is good for that run only. A
 * password the person asked to keep is given once per run; a second password
 * question in the same run means it did not fit, and the person is asked with
 * «Пароль не подошёл» (Review Focus 4): no loop, no lockout by repeats.
 *
 * A password travels only through the pipe and the client's stdout; the log
 * gets the kind of question, never the answer.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { SshPrompt, SshPromptAnswer } from '../../shared/types'
import { controlDir, shq } from './sshArgs'

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

/** The lines are the probe's (task 7): OpenSSH 9.5 and 10.2 differ in the fingerprint line. */
export function classifyPrompt(text: string): ClassifiedPrompt {
  if (/continue connecting \(yes\/no(\/\[fingerprint\])?\)\?/.test(text)) {
    const host = /^The authenticity of host '([^']*)'/m.exec(text)?.[1]
    const key = /^(\S+) key fingerprint is:? (SHA256:[A-Za-z0-9+/=]+)\.?[ \t\r]*$/m.exec(text)
    return {
      kind: 'hostKey',
      ...(host !== undefined ? { host: host.replace(/ \(.*\)$/, '') } : {}),
      ...(key ? { keyType: key[1]!, fingerprint: key[2]! } : {})
    }
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

export interface AskpassSpawn {
  env: Record<string, string>
  done(): void
}

export interface AskpassDeps {
  platform: NodeJS.Platform
  execPath: string
  userData: string
  ask: (p: SshPrompt) => Promise<SshPromptAnswer>
  storedPassword: (hostId: string) => string | null
  onRemember: (hostId: string, password: string) => void
  /** Whether «Запомнить» can be offered (safeStorage works). */
  canRemember?: () => boolean
  /** out/main/askpass.js, for the POSIX wrapper. */
  askpassScript?: string
  uid?: number
  log?: (line: string) => void
}

interface SpawnState {
  hostId: string
  interactive: boolean
  storedGiven: boolean
  passwordsAsked: number
}

const MAX_REQUEST_BYTES = 64 * 1024

type Reply = { ok: true; value: string } | { ok: false }

export class AskpassServer {
  private server: Server | null = null
  private pipePath = ''
  private readonly spawns = new Map<string, SpawnState>()

  constructor(private readonly deps: AskpassDeps) {}

  get path(): string {
    return this.pipePath
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve()
    const rand = randomBytes(8).toString('hex')
    if (this.deps.platform === 'win32') {
      this.pipePath = `\\\\.\\pipe\\qclod-askpass-${rand}`
    } else {
      const dir = controlDir(this.deps.uid ?? process.getuid?.() ?? 0)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      this.pipePath = join(dir, `askpass-${rand}.sock`)
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

  /** The POSIX wrapper ssh runs as SSH_ASKPASS: no Dock icon (ELECTRON_RUN_AS_NODE). */
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

  /** The env one ssh run gets; `done()` when it has exited. */
  forSpawn(hostId: string, o: { interactive: boolean }): AskpassSpawn {
    const token = randomBytes(24).toString('hex')
    this.spawns.set(token, { hostId, interactive: o.interactive, storedGiven: false, passwordsAsked: 0 })
    const askpass = this.deps.platform === 'win32' ? this.deps.execPath : this.writeAskpassScript()
    return {
      env: {
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: ':0',
        QCLOD_ASKPASS_PIPE: this.pipePath,
        QCLOD_ASKPASS_TOKEN: token
      },
      done: () => {
        this.spawns.delete(token)
      }
    }
  }

  private serve(socket: Socket): void {
    let buffer = ''
    let handled = false
    socket.setEncoding('utf8')
    const reply = (r: Reply): void => {
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
      this.answer(token, prompt).then(reply, () => reply({ ok: false }))
    })
    socket.on('error', () => socket.destroy())
  }

  private async answer(token: string, prompt: string): Promise<Reply> {
    const spawn = this.spawns.get(token)
    if (!spawn) return { ok: false }
    const c = classifyPrompt(prompt)
    this.deps.log?.(`askpass: ${c.kind}${spawn.interactive ? '' : ' (фон)'}`)
    const promptId = randomBytes(8).toString('hex')

    if (c.kind === 'password') {
      spawn.passwordsAsked++
      if (spawn.passwordsAsked === 1 && !spawn.storedGiven) {
        const stored = this.deps.storedPassword(spawn.hostId)
        if (stored !== null) {
          spawn.storedGiven = true
          return { ok: true, value: stored }
        }
      }
      if (!spawn.interactive) return { ok: false }
      const a = await this.deps.ask({
        promptId,
        hostId: spawn.hostId,
        kind: 'password',
        text: c.host ?? prompt,
        canRemember: this.deps.canRemember?.() ?? true,
        retry: spawn.passwordsAsked > 1
      })
      if (!a.ok || a.promptId !== promptId || !this.spawns.has(token)) return { ok: false }
      if (a.remember) this.deps.onRemember(spawn.hostId, a.value)
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
    const a = await this.deps.ask(p)
    if (!a.ok || a.promptId !== promptId || !this.spawns.has(token)) return { ok: false }
    return { ok: true, value: c.kind === 'hostKey' ? 'yes' : a.value }
  }
}
