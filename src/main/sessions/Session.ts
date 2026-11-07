import { spawn, type IPty } from '@lydell/node-pty'
import type { TabId } from '../../shared/types'
import { resolveExecutable } from './resolveExecutable'

export interface SessionOptions {
  tabId: TabId
  cwd: string
  /** Agent executable: absolute path, or a bare name to resolve on PATH. */
  file: string
  args: string[]
  cols?: number
  rows?: number
  env?: NodeJS.ProcessEnv
}

type DataListener = (chunk: string) => void
type ExitListener = (code: number) => void

/** One tab's agent, running in a real pty. */
export class Session {
  readonly tabId: TabId
  readonly cwd: string
  readonly args: string[]

  private readonly file: string
  private readonly env: NodeJS.ProcessEnv
  private pty: IPty | null = null
  private cols: number
  private rows: number
  private readonly dataListeners = new Set<DataListener>()
  private readonly exitListeners = new Set<ExitListener>()
  private exited = false

  constructor(options: SessionOptions) {
    this.tabId = options.tabId
    this.cwd = options.cwd
    this.file = options.file
    this.args = options.args
    this.env = options.env ?? process.env
    this.cols = options.cols ?? 100
    this.rows = options.rows ?? 30
  }

  get pid(): number {
    return this.pty?.pid ?? 0
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }

  get running(): boolean {
    return this.pty !== null && !this.exited
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** Throws AgentNotFoundError if the executable cannot be resolved. */
  start(): void {
    if (this.pty) return
    const file = resolveExecutable(this.file, this.env)

    this.pty = spawn(file, this.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: { ...this.env, TERM: 'xterm-256color' } as Record<string, string>
    })

    this.pty.onData((chunk) => {
      for (const listener of this.dataListeners) listener(chunk)
    })

    this.pty.onExit(({ exitCode }) => {
      this.exited = true
      for (const listener of this.exitListeners) listener(exitCode)
    })
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.floor(cols))
    this.rows = Math.max(1, Math.floor(rows))
    if (!this.pty || this.exited) return
    try {
      this.pty.resize(this.cols, this.rows)
    } catch {
      /* the process went away between the check and the call */
    }
  }

  async dispose(): Promise<void> {
    const pty = this.pty
    if (!pty) return
    this.dataListeners.clear()

    if (this.exited) {
      this.pty = null
      this.exitListeners.clear()
      return
    }

    const gone = new Promise<void>((resolveGone) => {
      const timer = setTimeout(resolveGone, 2000)
      pty.onExit(() => {
        clearTimeout(timer)
        resolveGone()
      })
    })

    try {
      pty.kill()
    } catch {
      /* already gone */
    }

    await gone
    this.exited = true
    this.pty = null
    this.exitListeners.clear()
  }
}
