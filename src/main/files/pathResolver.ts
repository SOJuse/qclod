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
/** How long a tab may act on a path after it last found it. */
const GRANT_TTL_MS = 30 * 60_000
const MAX_ENTRIES = 5000
const MAX_PER_CALL = 200

/** CON, nul.txt, COM1, `aux .ts`: Windows opens the device, whatever the folder. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i

/**
 * A local drive path and nothing else. A network path (`\\server\…`), a
 * device path (`\\?\`, `\\.\`) and an NTFS stream (`a.txt:stream`) never
 * reach the disk: merely looking one up makes Windows offer the user's NTLM
 * hash to whatever server the agent named.
 */
function isLocalDrivePath(abs: string): boolean {
  return /^[A-Za-z]:\\/.test(abs) && !abs.includes(':', 2) && !abs.includes('\0')
}

function namesDevice(abs: string): boolean {
  return abs
    .split('\\')
    .slice(1)
    .some((segment) => DEVICE_NAME.test(segment.replace(/[. ]+$/, '').split('.')[0]!.trimEnd()))
}

/** Map order is insertion order: re-inserting keeps the oldest first, then trims. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value as string)
}

/**
 * Tells which of the path candidates in a tab's text exist, relative to the
 * tab's folder. Answers are remembered for a while, so a long conversation
 * re-rendering its links does not hit the disk each time.
 *
 * It also records which tab found which path, and that is what every action
 * checks. The renderer can still ask about any local path, so this does not
 * prove the agent wrote it: it narrows a buggy or compromised window to paths
 * its own tab looked up recently. The rest is fileActions' job (nothing
 * runnable is ever opened).
 */
export class PathResolver {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly stat: Stat
  private readonly cache = new Map<string, Entry>()
  /** `scope\0absPath` → when that scope last found the path on disk. */
  private readonly grants = new Map<string, number>()

  constructor(opts: { ttlMs?: number; maxEntries?: number; stat?: Stat } = {}) {
    this.ttlMs = opts.ttlMs ?? TTL_MS
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES
    this.stat = opts.stat ?? fsStat
  }

  /** `scope` is the asking tab: only it may then act on what was found. */
  async resolve(cwd: string, raws: string[], scope: string): Promise<Array<ResolvedPath | null>> {
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
        remember(this.grants, `${scope}\0${abs}`, Date.now(), this.maxEntries)
        const out: ResolvedPath = { raw, absPath: abs, isDir: entry.isDir }
        if (line !== undefined) out.line = line
        if (column !== undefined) out.column = column
        return out
      })
    )
  }

  /** Whether `scope` found `absPath` on disk in the last 30 minutes — the gate for every action. */
  knows(absPath: string, scope: string): boolean {
    const at = this.grants.get(`${scope}\0${absPath}`)
    return at !== undefined && Date.now() - at <= GRANT_TTL_MS
  }

  /** A closed tab's paths stop working. */
  forget(scope: string): void {
    for (const key of [...this.grants.keys()]) {
      if (key.startsWith(`${scope}\0`)) this.grants.delete(key)
    }
  }

  private absolute(cwd: string, path: string): string | null {
    if (path === '' || path.startsWith('\\\\') || path.startsWith('//')) return null
    // `C:foo` is relative to drive C's own current folder, not the tab's.
    if (/^[A-Za-z]:(?![\\/])/.test(path)) return null
    if (!isLocalDrivePath(win32.resolve(cwd))) return null
    const abs = win32.resolve(cwd, path)
    return isLocalDrivePath(abs) && !namesDevice(abs) ? abs : null
  }

  private async lookup(abs: string): Promise<Entry> {
    const now = Date.now()
    // Only a "yes" is reused. Agents name a file before they create it, and
    // the window asks again right after a write: a remembered "no" would hide
    // the new file. Within one call a path is still looked up once.
    const cached = this.cache.get(abs)
    if (cached && cached.exists && now - cached.at <= this.ttlMs) return cached

    let entry: Entry
    try {
      const st = await this.stat(abs)
      entry = { exists: true, isDir: st.isDirectory(), at: now }
    } catch {
      this.cache.delete(abs)
      return { exists: false, isDir: false, at: now }
    }
    remember(this.cache, abs, entry, this.maxEntries)
    return entry
  }
}
