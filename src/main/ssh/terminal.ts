/**
 * The server's terminal (stage 6, task 26; decision 7): a drawer under a
 * server chat's ribbon, `ssh -tt` to the server in the chat's folder, in a
 * real local terminal (node-pty; ConPTY on Windows). Only a real terminal
 * makes ssh hear the window change size and send `window-change` — over plain
 * pipes the server's terminal stays 80×24 and vim or htop break on a resize.
 */
import { randomUUID } from 'node:crypto'
import { CHANNELS } from '../../shared/channels'
import type { TabId } from '../../shared/types'
import { shq, sshBaseArgs, type SshTarget } from './sshArgs'
import { sshEnv } from './sshRun'

export interface IPtyLike {
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(d: string): void
  resize(c: number, r: number): void
  kill(): void
}

export type TerminalSpawn = (
  file: string,
  args: string[],
  o: { cols: number; rows: number; cwd?: string; env: NodeJS.ProcessEnv; name: string }
) => IPtyLike

export const TERM_INPUT_MAX = 64 * 1024
export const TERM_COLS = { min: 2, max: 500 }
export const TERM_ROWS = { min: 2, max: 200 }

/** Columns and rows a terminal may have; anything else is no size. */
export function termSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  const ok = (n: unknown, b: { min: number; max: number }): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= b.min && n <= b.max
  return ok(cols, TERM_COLS) && ok(rows, TERM_ROWS) ? { cols, rows } : null
}

/** What runs on the server: a login shell in the chat's folder. `~/…` stays for the server to expand. */
export function shellCommand(cwd: string): string {
  const where = cwd === '~' ? '~' : cwd.startsWith('~/') ? `~/${shq(cwd.slice(2))}` : shq(cwd)
  return `cd ${where} && exec "$SHELL" -l`
}

export interface TerminalHubDeps {
  spawnPty: TerminalSpawn
  send: (ch: string, payload: unknown) => void
  sshPath?: string
  platform?: NodeJS.Platform
  userData?: string
  uid?: number
}

interface Term {
  tabId: TabId
  pty: IPtyLike
  /** Releases what the terminal held (its askpass token). */
  onEnd?: () => void
}

/** Every open server terminal, by id; a tab may have more than one. */
export class TerminalHub {
  private readonly terms = new Map<string, Term>()

  constructor(private readonly deps: TerminalHubDeps) {}

  open(
    tabId: TabId,
    target: SshTarget,
    cwd: string,
    askpassEnv: Record<string, string>,
    size: { cols: number; rows: number },
    onEnd?: () => void
  ): string {
    const args = [
      ...sshBaseArgs(target, {
        platform: this.deps.platform ?? process.platform,
        userData: this.deps.userData ?? '',
        ...(this.deps.uid !== undefined ? { uid: this.deps.uid } : {}),
        batch: false,
        tty: true
      }),
      '--',
      shellCommand(cwd)
    ]
    return this.start(tabId, this.deps.sshPath ?? 'ssh', args, size, sshEnv(askpassEnv), onEnd)
  }

  /** Any program in a terminal of the hub — the e2e build's local shell in place of ssh. */
  start(
    tabId: TabId,
    file: string,
    args: string[],
    size: { cols: number; rows: number },
    env: NodeJS.ProcessEnv,
    onEnd?: () => void
  ): string {
    const termId = randomUUID()
    const pty = this.deps.spawnPty(file, args, { cols: size.cols, rows: size.rows, env, name: 'xterm-256color' })
    const term: Term = { tabId, pty, ...(onEnd ? { onEnd } : {}) }
    this.terms.set(termId, term)
    pty.onData((data) => {
      if (this.terms.get(termId) === term) this.deps.send(CHANNELS.terminalData, { termId, data })
    })
    pty.onExit(({ exitCode }) => {
      if (this.terms.get(termId) !== term) return
      this.terms.delete(termId)
      term.onEnd?.()
      this.deps.send(CHANNELS.terminalExit, { termId, exitCode })
    })
    return termId
  }

  /** false — not ours, or more than 64 KiB at once. */
  input(termId: string, data: string): boolean {
    const term = this.terms.get(termId)
    if (!term || typeof data !== 'string' || data.length > TERM_INPUT_MAX) return false
    term.pty.write(data)
    return true
  }

  resize(termId: string, cols: number, rows: number): boolean {
    const term = this.terms.get(termId)
    const size = termSize(cols, rows)
    if (!term || !size) return false
    try {
      term.pty.resize(size.cols, size.rows)
    } catch {
      // Exited meanwhile.
    }
    return true
  }

  close(termId: string): void {
    const term = this.terms.get(termId)
    if (!term) return
    this.terms.delete(termId)
    term.onEnd?.()
    try {
      term.pty.kill()
    } catch {
      // Gone already.
    }
  }

  /** «Закрыть чат» closes its terminals. */
  closeTab(tabId: TabId): void {
    for (const [termId, term] of [...this.terms]) if (term.tabId === tabId) this.close(termId)
  }

  closeAll(): void {
    for (const termId of [...this.terms.keys()]) this.close(termId)
  }

  has(termId: string): boolean {
    return this.terms.has(termId)
  }
}

/** node-pty, loaded when the first terminal opens: a native module is not needed before. */
export async function nodePtySpawn(): Promise<TerminalSpawn> {
  const pty = (await import('node-pty')) as typeof import('node-pty')
  return (file, args, o) => {
    const p = pty.spawn(file, args, {
      name: o.name,
      cols: o.cols,
      rows: o.rows,
      ...(o.cwd ? { cwd: o.cwd } : {}),
      env: o.env as Record<string, string>
    })
    return {
      onData: (cb) => void p.onData(cb),
      onExit: (cb) => void p.onExit((e) => cb({ exitCode: e.exitCode })),
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      kill: () => p.kill()
    }
  }
}
