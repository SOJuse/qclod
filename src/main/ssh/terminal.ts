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
/** The output a terminal keeps for a drawer that comes back (R1): its last 256 KiB. */
export const TERM_BACKLOG_MAX = 256 * 1024
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
  /** The last output, newest at the end, at most TERM_BACKLOG_MAX in all. */
  backlog: string[]
  backlogSize: number
  /** Releases what the terminal held (its askpass token). */
  /** `exitCode` when ssh exited by itself; none when the drawer closed it. */
  onEnd?: (exitCode?: number) => void
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
    onEnd?: (exitCode?: number) => void
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
    onEnd?: (exitCode?: number) => void,
    cwd?: string
  ): string {
    const termId = randomUUID()
    const pty = this.deps.spawnPty(file, args, {
      cols: size.cols,
      rows: size.rows,
      env,
      name: 'xterm-256color',
      ...(cwd ? { cwd } : {})
    })
    const term: Term = { tabId, pty, backlog: [], backlogSize: 0, ...(onEnd ? { onEnd } : {}) }
    this.terms.set(termId, term)
    pty.onData((data) => {
      if (this.terms.get(termId) !== term) return
      keep(term, data)
      this.deps.send(CHANNELS.terminalData, { termId, data })
    })
    pty.onExit(({ exitCode }) => {
      if (this.terms.get(termId) !== term) return
      this.terms.delete(termId)
      term.onEnd?.(exitCode)
      this.deps.send(CHANNELS.terminalExit, { termId, exitCode })
    })
    return termId
  }

  /**
   * A drawer mounted again (its chat came back to a pane) takes up the same
   * session: what the terminal printed meanwhile, its last 256 KiB. null — no
   * such terminal on this tab (it exited, or never was).
   */
  attach(tabId: TabId, termId: string): string | null {
    const term = this.terms.get(termId)
    if (!term || term.tabId !== tabId) return null
    return term.backlog.join('')
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

/** Adds output to a terminal's backlog, dropping its oldest part past TERM_BACKLOG_MAX. */
function keep(term: Term, data: string): void {
  term.backlog.push(data)
  term.backlogSize += data.length
  while (term.backlogSize > TERM_BACKLOG_MAX) {
    const first = term.backlog[0]!
    const over = term.backlogSize - TERM_BACKLOG_MAX
    if (first.length <= over) {
      term.backlog.shift()
      term.backlogSize -= first.length
    } else {
      term.backlog[0] = first.slice(over)
      term.backlogSize -= over
    }
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
