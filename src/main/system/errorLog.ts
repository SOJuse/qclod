import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ErrorEntry {
  source: 'renderer' | 'main'
  scope?: string
  message: string
  stack?: string
  at: number
}

const FILE = 'qclod.log'

/**
 * What went wrong, one JSON object per line, for whoever has to find out why
 * the window broke. Small by construction: past `maxBytes` the file becomes
 * qclod.1.log (older ones shift up) and only `keep` old files stay.
 */
export class ErrorLog {
  private readonly maxBytes: number
  private readonly keep: number

  constructor(
    private readonly dir: string,
    opts: { maxBytes?: number; keep?: number } = {}
  ) {
    this.maxBytes = opts.maxBytes ?? 1024 * 1024
    this.keep = opts.keep ?? 3
  }

  /** Never throws: a log that cannot be written must not become the next error. */
  write(entry: ErrorEntry): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const line = JSON.stringify(entry) + '\n'
      this.rotateFor(Buffer.byteLength(line))
      appendFileSync(join(this.dir, FILE), line, 'utf8')
    } catch (err) {
      console.warn('[errorLog]', err instanceof Error ? err.message : String(err))
    }
  }

  private rotateFor(incoming: number): void {
    const current = join(this.dir, FILE)
    if (!existsSync(current) || statSync(current).size + incoming <= this.maxBytes) return
    if (this.keep < 1) {
      rmSync(current, { force: true })
      return
    }
    rmSync(this.old(this.keep), { force: true })
    for (let i = this.keep - 1; i >= 1; i--) {
      if (existsSync(this.old(i))) renameSync(this.old(i), this.old(i + 1))
    }
    renameSync(current, this.old(1))
  }

  private old(n: number): string {
    return join(this.dir, `qclod.${n}.log`)
  }
}
