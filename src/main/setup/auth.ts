import { execFile, spawn } from 'node:child_process'
import type { AuthStatus, LoginProgress } from '../../shared/types'
import { quoteArg } from './install'

export type { AuthStatus, LoginProgress }

/** How long one `claude auth status` may take before it counts as unknown. */
export const AUTH_STATUS_TIMEOUT_MS = 15000

/** Pause between two status checks while someone is logging in. */
export const LOGIN_POLL_MS = 2000

/** After this the watch gives up; the person can always start it again. */
export const LOGIN_WATCH_MAX_MS = 600000

export type ExecLike = (
  file: string,
  args: string[],
  opts: { timeout: number; windowsHide: true }
) => Promise<{ stdout: string; code: number | null }>

/**
 * Reads only `loggedIn`, and only when it is a boolean. The rest of the JSON
 * (email, organisation) is never looked at. A non-zero exit code with valid
 * JSON is normal: the CLI exits with 1 when nobody is logged in.
 */
export function parseAuthStatus(stdout: string, _exitCode: number | null): AuthStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return 'unknown'
  }
  if (parsed === null || typeof parsed !== 'object') return 'unknown'
  const loggedIn = (parsed as { loggedIn?: unknown }).loggedIn
  if (typeof loggedIn !== 'boolean') return 'unknown'
  return loggedIn ? 'in' : 'out'
}

/**
 * execFile that resolves with stdout and the exit code even when the code is
 * not zero. Only a failure to run at all (ENOENT, timeout) rejects — and its
 * error carries no stdout.
 */
const execAnyCode: ExecLike = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, opts, (error, stdout) => {
      if (error && typeof error.code !== 'number') {
        reject(new Error(`auth status did not run: ${String(error.code ?? 'error')}`))
        return
      }
      resolve({ stdout: String(stdout), code: error ? (error.code as number) : 0 })
    })
  })

/** `claude auth status --json`, reduced to in / out / unknown. Never throws. */
export async function readAuthStatus(agent: string, exec: ExecLike = execAnyCode): Promise<AuthStatus> {
  const args = ['auth', 'status', '--json']
  // An older npm package is a cli.js, which only node can run.
  const [file, fullArgs] = /\.js$/i.test(agent) ? ['node', [agent, ...args]] : [agent, args]
  try {
    const { stdout, code } = await exec(file, fullArgs, {
      timeout: AUTH_STATUS_TIMEOUT_MS,
      windowsHide: true
    })
    return parseAuthStatus(stdout, code)
  } catch {
    // Deliberately silent: whatever the CLI printed may hold personal data.
    return 'unknown'
  }
}

/** The line typed into the login window. */
export function loginCommandLine(agent: string): string {
  const program = /\.js$/i.test(agent) ? `node ${quoteArg(agent)}` : quoteArg(agent)
  return `${program} auth login`
}

/**
 * Opens a console window running `claude auth login`. The inner `cmd /k`
 * sees more than two quotes and strips only the first and last, so a path
 * with a space arrives whole. The window stays open after the login (`/k`),
 * so the person sees the CLI's answer.
 */
export function openLoginWindow(agent: string): void {
  spawn('cmd.exe', ['/d', '/s', '/c', `"start "" cmd.exe /k "${loginCommandLine(agent)}""`], {
    detached: true,
    windowsHide: false,
    windowsVerbatimArguments: true
  }).unref()
}

export interface LoginWatchDeps {
  check: () => Promise<AuthStatus>
  onProgress: (p: LoginProgress) => void
  intervalMs?: number
  maxMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

/**
 * Polls the login status until it says 'in' or the time runs out. One loop
 * at a time; the next check is scheduled only after the previous answered,
 * so a slow CLI never piles up processes.
 */
export class LoginWatch {
  private timer: unknown = null
  private active = false
  /** Bumped on every start/stop, so an answer from an old loop is ignored. */
  private generation = 0
  private deadline = 0

  constructor(private readonly deps: LoginWatchDeps) {}

  get running(): boolean {
    return this.active
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.generation++
    this.deadline = this.now() + (this.deps.maxMs ?? LOGIN_WATCH_MAX_MS)
    this.deps.onProgress('waiting')
    this.schedule(this.generation)
  }

  stop(): void {
    this.active = false
    this.generation++
    if (this.timer !== null) {
      this.clear(this.timer)
      this.timer = null
    }
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))()
  }

  private clear(t: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(t)
    else clearTimeout(t as ReturnType<typeof setTimeout>)
  }

  private schedule(generation: number): void {
    const interval = this.deps.intervalMs ?? LOGIN_POLL_MS
    const fire = (): void => {
      this.timer = null
      void this.tick(generation)
    }
    this.timer = this.deps.setTimer ? this.deps.setTimer(fire, interval) : setTimeout(fire, interval)
  }

  private async tick(generation: number): Promise<void> {
    let status: AuthStatus
    try {
      status = await this.deps.check()
    } catch {
      status = 'unknown'
    }
    if (generation !== this.generation) return
    if (status === 'in') {
      this.stop()
      this.deps.onProgress('in')
      return
    }
    if (this.now() >= this.deadline) {
      this.stop()
      this.deps.onProgress('timeout')
      return
    }
    this.schedule(generation)
  }
}
