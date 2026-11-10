import { stat as fsStat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { splitLineSuffix } from '../../shared/pathCandidates'
import type { ResolvedPath } from '../../shared/types'

type Stat = (p: string) => Promise<{ isDirectory(): boolean }>

interface Entry {
  exists: boolean
  isDir: boolean
  at: number
}

const TTL_MS = 30_000
const MAX_ENTRIES = 5000
const MAX_PER_CALL = 200

/**
 * A local drive path and nothing else. A network path (`\\server\…`), a
 * device path (`\\?\`, `\\.\`) and an NTFS stream (`a.txt:stream`) never
 * reach the disk: merely looking one up makes Windows offer the user's NTLM
 * hash to whatever server the agent named.
 */
function isLocalDrivePath(abs: string): boolean {
  return /^[A-Za-z]:\\/.test(abs) && !abs.includes(':', 2) && !abs.includes('\0')
}

/**
 * Tells which of the path candidates in a tab's text exist, relative to the
 * tab's folder. Answers are remembered for a while, so a long conversation
 * re-rendering its links does not hit the disk each time.
 */
export class PathResolver {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly stat: Stat
  private readonly cache = new Map<string, Entry>()

  constructor(opts: { ttlMs?: number; maxEntries?: number; stat?: Stat } = {}) {
    this.ttlMs = opts.ttlMs ?? TTL_MS
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES
    this.stat = opts.stat ?? fsStat
  }

  async resolve(cwd: string, raws: string[]): Promise<Array<ResolvedPath | null>> {
    const pending = new Map<string, Promise<Entry>>()
    return Promise.all(
      raws.map(async (raw, i) => {
        if (i >= MAX_PER_CALL) return null
        const { path, line, column } = splitLineSuffix(raw)
        const abs = this.absolute(cwd, path)
        if (abs === null) return null
        let lookup = pending.get(abs)
        if (!lookup) {
          lookup = this.lookup(abs)
          pending.set(abs, lookup)
        }
        const entry = await lookup
        if (!entry.exists) return null
        const out: ResolvedPath = { raw, absPath: abs, isDir: entry.isDir }
        if (line !== undefined) out.line = line
        if (column !== undefined) out.column = column
        return out
      })
    )
  }

  /** Whether `absPath` was found on disk by an earlier `resolve` — the gate for every action. */
  knows(absPath: string): boolean {
    return this.cache.get(absPath)?.exists === true
  }

  private absolute(cwd: string, path: string): string | null {
    if (path === '' || path.startsWith('\\\\') || path.startsWith('//')) return null
    if (!isLocalDrivePath(win32.resolve(cwd))) return null
    const abs = win32.resolve(cwd, path)
    return isLocalDrivePath(abs) ? abs : null
  }

  private async lookup(abs: string): Promise<Entry> {
    const now = Date.now()
    const cached = this.cache.get(abs)
    if (cached && now - cached.at <= this.ttlMs) return cached

    let entry: Entry
    try {
      const st = await this.stat(abs)
      entry = { exists: true, isDir: st.isDirectory(), at: now }
    } catch {
      entry = { exists: false, isDir: false, at: now }
    }
    // Re-inserted, so the Map's order stays oldest first.
    this.cache.delete(abs)
    this.cache.set(abs, entry)
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string
      this.cache.delete(oldest)
    }
    return entry
  }
}
