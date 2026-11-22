/**
 * `claude auth login` on a server, from Qclod (stage 6, I13): ssh with a
 * terminal (`-tt`), the sign-in link shown in the window, the code from the
 * browser typed back. Qclod reads only the link and the outcome; the account
 * itself is asked of the relay (`auth.status`) after the code.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { ServerAuth } from '../../shared/relayProtocol'
import { LOGIN_POLL_MS, LOGIN_WATCH_MAX_MS } from '../setup/auth'
import { remoteCommand, sshBaseArgs, type SshTarget } from './sshArgs'
import { sshEnv } from './sshRun'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

function plain(output: string): string {
  return output.replace(ANSI, '').replace(/\r/g, '')
}

/** The first https link to claude.ai or anthropic.com, after the terminal's escapes are gone. */
export function findLoginUrl(output: string): string | null {
  const text = plain(output)
  for (const m of text.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    let url: URL
    try {
      url = new URL(m[0])
    } catch {
      continue
    }
    const host = url.hostname
    if (url.protocol !== 'https:') continue
    if (host === 'claude.ai' || host.endsWith('.claude.ai') || host === 'anthropic.com' || host.endsWith('.anthropic.com')) {
      return url.toString()
    }
  }
  return null
}

/**
 * How the CLI said it went. The lines are the CLI's own; the live probe of
 * `claude auth login` on a server was not run (Ruling S6-R2), so these are the
 * CLI's known words — the account is checked through `auth.status` anyway.
 */
export function loginOutcome(output: string): 'ok' | 'failed' | null {
  const text = plain(output)
  if (/Login successful|Successfully logged in|Logged in as/i.test(text)) return 'ok'
  if (/Login failed|OAuth error|Invalid (authorization )?code|Authentication failed|Error:/i.test(text)) return 'failed'
  return null
}

/** What ServerLogin needs of a terminal: node-pty's shape, or ssh -tt over pipes. */
export interface IPtyLike {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  kill(): void
}

export type SpawnPty = (file: string, args: string[], o: { cols: number; rows: number; env: NodeJS.ProcessEnv }) => IPtyLike

/**
 * ssh -tt over plain pipes: the server gets a terminal of 80×24 that never
 * changes size — enough for a sign-in that prints a link and reads a line.
 * (The server's terminal panel, task 26, is node-pty's.)
 */
export const pipePty: SpawnPty = (file, args, o) => {
  const child = nodeSpawn(file, args, { env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  return {
    onData: (cb) => {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', cb)
      child.stderr?.on('data', cb)
    },
    onExit: (cb) => {
      child.on('close', (code) => cb({ exitCode: code ?? -1 }))
      child.on('error', () => cb({ exitCode: -1 }))
    },
    write: (data) => {
      child.stdin?.write(data)
    },
    kill: () => {
      child.kill()
    }
  }
}

export interface LoginProgressEvent {
  url?: string
  state: 'starting' | 'waitingCode' | 'checking' | 'done' | 'failed'
  email?: string
  error?: string
}

export interface ServerLoginDeps {
  spawnPty: SpawnPty
  onProgress: (p: LoginProgressEvent) => void
  recheck: () => Promise<ServerAuth>
  sshPath?: string
  platform?: NodeJS.Platform
  userData?: string
  uid?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  now?: () => number
}

const MAX_OUTPUT = 64 * 1024

export class ServerLogin {
  private pty: IPtyLike | null = null
  private output = ''
  private url: string | null = null
  private finished = false
  private watch: unknown = null
  private poll: unknown = null

  constructor(private readonly deps: ServerLoginDeps) {}

  private timer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms)
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  }

  private clear(h: unknown): void {
    if (h === null) return
    if (this.deps.clearTimer) this.deps.clearTimer(h)
    else clearTimeout(h as ReturnType<typeof setTimeout>)
  }

  /** ssh -tt … -- '<claude>' auth login */
  start(target: SshTarget, claudePath: string, askpassEnv: Record<string, string>): void {
    this.cancel()
    this.finished = false
    this.output = ''
    this.url = null
    const args = [
      ...sshBaseArgs(target, {
        platform: this.deps.platform ?? process.platform,
        userData: this.deps.userData ?? '',
        ...(this.deps.uid !== undefined ? { uid: this.deps.uid } : {}),
        batch: false,
        tty: true
      }),
      '--',
      remoteCommand([claudePath, 'auth', 'login'])
    ]
    this.deps.onProgress({ state: 'starting' })
    const pty = this.deps.spawnPty(this.deps.sshPath ?? 'ssh', args, { cols: 120, rows: 40, env: sshEnv(askpassEnv) })
    this.pty = pty
    pty.onData((data) => {
      if (this.pty !== pty || this.finished) return
      if (this.output.length < MAX_OUTPUT) this.output += data
      if (!this.url) {
        const url = findLoginUrl(this.output)
        if (url) {
          this.url = url
          this.deps.onProgress({ url, state: 'waitingCode' })
        }
      }
      const outcome = loginOutcome(this.output)
      if (outcome === 'ok') void this.check()
      else if (outcome === 'failed') this.fail(lastLine(this.output) || 'вход не удался')
    })
    pty.onExit(({ exitCode }) => {
      if (this.pty !== pty || this.finished) return
      this.pty = null
      // The CLI is gone: whatever it said, the account says the rest.
      void this.check(exitCode === 0 ? undefined : lastLine(this.output) || `код ${exitCode}`)
    })
    this.watch = this.timer(() => {
      if (!this.finished) this.fail('Время входа вышло')
    }, LOGIN_WATCH_MAX_MS)
  }

  /** The code from the browser, and Enter. */
  sendCode(code: string): void {
    if (!this.pty || this.finished) return
    this.pty.write(code + '\r')
    this.deps.onProgress({ state: 'checking', ...(this.url ? { url: this.url } : {}) })
    this.pollAccount()
  }

  cancel(): void {
    this.clear(this.watch)
    this.clear(this.poll)
    this.watch = null
    this.poll = null
    const pty = this.pty
    this.pty = null
    pty?.kill()
  }

  private pollAccount(): void {
    this.clear(this.poll)
    this.poll = this.timer(() => {
      if (this.finished) return
      void this.deps.recheck().then(
        (auth) => {
          if (this.finished) return
          if (auth.loggedIn === true) this.done(auth)
          else this.pollAccount()
        },
        () => {
          if (!this.finished) this.pollAccount()
        }
      )
    }, LOGIN_POLL_MS)
  }

  private async check(why?: string): Promise<void> {
    if (this.finished) return
    this.deps.onProgress({ state: 'checking', ...(this.url ? { url: this.url } : {}) })
    let auth: ServerAuth | null = null
    try {
      auth = await this.deps.recheck()
    } catch {
      auth = null
    }
    if (this.finished) return
    if (auth?.loggedIn === true) this.done(auth)
    else this.fail(why ?? 'вход не подтвердился')
  }

  private done(auth: ServerAuth): void {
    this.finished = true
    this.deps.onProgress({ state: 'done', ...(auth.email ? { email: auth.email } : {}) })
    this.cancel()
  }

  private fail(error: string): void {
    if (this.finished) return
    this.finished = true
    this.deps.onProgress({ state: 'failed', error })
    this.cancel()
  }
}

function lastLine(output: string): string {
  return plain(output).trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
}
