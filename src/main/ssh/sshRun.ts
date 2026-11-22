/**
 * One ssh command to a server, before its relay is there (decision 2): the
 * probe, the upload of the relay, its setup. The system ssh, Qclod's base
 * arguments and askpass for every question. Everything after the relay is
 * installed goes through `qclod-relay attach` (transport.ts).
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { AskpassServer } from './askpass'
import { controlDir, ensurePrivateDir, sshBaseArgs, type PrivateDirFs, type SshTarget } from './sshArgs'

export interface SshRunResult {
  code: number | null
  stdout: string
  stderr: string
}

export type SshFailure = 'hostKeyChanged' | 'authFailed' | 'unreachable' | 'refused' | 'other'

export function classifySshFailure(stderr: string, code: number | null): SshFailure {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)) return 'hostKeyChanged'
  if (/Permission denied/.test(stderr)) return 'authFailed'
  if (/Could not resolve hostname|timed out|No route/i.test(stderr)) return 'unreachable'
  if (/Connection refused/.test(stderr)) return 'refused'
  if (code === null) return 'unreachable'
  return 'other'
}

export type SpawnFn = (file: string, args: string[], o: SpawnOptions) => ChildProcess

export interface SshContext {
  sshPath: string
  platform: NodeJS.Platform
  userData: string
  uid?: number
  askpass: AskpassServer
  spawn?: SpawnFn
  /** Tests: the checks of the ControlMaster folder. */
  dirFs?: PrivateDirFs
}

let context: SshContext | null = null

/** main sets it once (index.ts); tests set their own. */
export function setSshContext(ctx: SshContext | null): void {
  context = ctx
}

export function sshContext(): SshContext {
  if (!context) throw new Error('ssh не настроен')
  return context
}

/** The system ssh: Windows' own OpenSSH when it is there, else whatever PATH has. */
export function findSsh(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const root = process.env['SystemRoot'] ?? 'C:\\Windows'
    const own = `${root}\\System32\\OpenSSH\\ssh.exe`
    if (existsSync(own)) return own
    return 'ssh.exe'
  }
  return 'ssh'
}

/**
 * The ControlMaster folder must exist before ssh puts a socket there, and be
 * this user's alone (ensurePrivateDir); throws otherwise. Windows has none.
 */
export function ensureControlDir(ctx: SshContext): void {
  if (ctx.platform === 'win32') return
  ensurePrivateDir(controlDir(ctx.uid ?? 0), ctx.uid ?? 0, ctx.dirFs)
}

/** ssh's own args, then `--` and the remote command. */
export function sshCommand(
  ctx: SshContext,
  t: SshTarget,
  remote: string,
  o: { interactive: boolean; tty?: boolean }
): string[] {
  const base = sshBaseArgs(t, {
    platform: ctx.platform,
    userData: ctx.userData,
    ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
    batch: !o.interactive,
    ...(o.tty ? { tty: true } : {})
  })
  return [...base, '--', remote]
}

/** The parts of the local env ssh itself needs; nothing else is passed along. */
export function sshEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'USERNAME', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'SSH_AUTH_SOCK']
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key]
  return { ...env, ...extra }
}

const MAX_OUTPUT = 4 * 1024 * 1024

/**
 * A timeout that stands still while ssh's question waits for the person (R4):
 * the probe's 90 s are ssh's, not the time somebody takes to type.
 */
export class PausableTimeout {
  private left: number
  private startedAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private paused = 0
  private stopped = false

  constructor(
    ms: number,
    private readonly fire: () => void,
    private readonly now: () => number = Date.now
  ) {
    this.left = ms
    this.arm()
  }

  private arm(): void {
    if (this.stopped || this.timer || this.paused > 0) return
    this.startedAt = this.now()
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.stopped || this.paused > 0) return
      this.stopped = true
      this.fire()
    }, Math.max(0, this.left))
  }

  pause(): void {
    this.paused++
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    this.left -= this.now() - this.startedAt
  }

  resume(): void {
    if (this.paused === 0) return
    this.paused--
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

export function sshRun(
  t: SshTarget,
  remote: string,
  o: { stdin?: Buffer | string; interactive: boolean; hostId: string; timeoutMs?: number }
): Promise<SshRunResult> {
  const ctx = sshContext()
  try {
    ensureControlDir(ctx)
  } catch (err) {
    return Promise.resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
  }
  let timeout: PausableTimeout | null = null
  const ask = ctx.askpass.forSpawn(o.hostId, {
    interactive: o.interactive,
    target: t.target,
    onAsking: (open) => (open ? timeout?.pause() : timeout?.resume())
  })
  const spawn = ctx.spawn ?? (nodeSpawn as SpawnFn)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const child = spawn(ctx.sshPath, sshCommand(ctx, t, remote, { interactive: o.interactive }), {
      env: sshEnv(ask.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      timeout?.stop()
      // Anything on stdout comes from the remote command: the sign-in was taken.
      if (code === 0 || stdout !== '') ask.authed()
      ask.done(classifySshFailure(stderr, code) === 'authFailed' ? { authFailed: true } : undefined)
      resolve({ code, stdout, stderr })
    }
    if (o.timeoutMs) {
      timeout = new PausableTimeout(o.timeoutMs, () => {
        child.kill()
        finish(null)
      })
      if (ask.asking()) timeout.pause()
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (s: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += s
    })
    child.stderr?.on('data', (s: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += s
    })
    child.on('error', (err) => {
      stderr += String(err.message)
      finish(null)
    })
    child.on('close', (code) => finish(code))
    child.stdin?.on('error', () => {
      // ssh went away before taking all of stdin: its exit code says why.
    })
    if (o.stdin !== undefined) child.stdin?.end(o.stdin)
    else child.stdin?.end()
  })
}
