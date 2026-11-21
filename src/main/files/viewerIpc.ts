import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { splitLineSuffix } from '../../shared/pathCandidates'
import type { FileSource, ResolvedPath, TabServer, ViewerContent } from '../../shared/types'
import { downloadRemote, readRemote, type RelayReader } from '../ssh/remoteFiles'
import { readLocal } from './viewer'

/** Longer is no path anyone wrote. */
const MAX_PATH = 4096
/** How long a tab may read a server path after fs.stat found it there. */
const GRANT_TTL_MS = 30 * 60_000
const MAX_GRANTS = 5000

export interface ViewerDeps {
  tab(id: string): { cwd: string; server?: TabServer | undefined } | undefined
  /** PathResolver.knows: the local tab found this path in its own text lately. */
  knowsLocal(absPath: string, tabId: string): boolean
  /** The relay of a server, raised if need be. */
  client(hostId: string): Promise<RelayReader>
  userData: string
  /** fileActions.openPath: a runnable file is shown in its folder, never run. */
  openPath(absPath: string): Promise<'opened' | 'revealed'>
  now?: () => number
}

function error(message: string): ViewerContent {
  return { kind: 'error', message }
}

function isPath(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= MAX_PATH && !value.includes('\0')
}

function readSource(raw: unknown): FileSource | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r['kind'] === 'local') return { kind: 'local' }
  if (r['kind'] === 'remote' && typeof r['hostId'] === 'string' && r['hostId'] !== '') {
    return { kind: 'remote', hostId: r['hostId'] }
  }
  return null
}

function insideLocal(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !isAbsolute(rel))
}

function insideRemote(path: string, dir: string): boolean {
  const p = posix.normalize(path)
  const d = posix.normalize(dir).replace(/\/+$/, '')
  return d !== '' && (p === d || p.startsWith(`${d}/`))
}

/**
 * The read-only viewer's side of main (stage 6, task 24), and the server
 * chat's path lookups. A path is read only when the asking tab may: inside its
 * folder, or one its own text named and main found (locally PathResolver, on a
 * server fs.stat). A compromised window gets no further than its chat could.
 */
export function viewerAccess(deps: ViewerDeps) {
  const now = deps.now ?? Date.now
  /** `tabId\0absPath` → when fs.stat found it for that tab. */
  const grants = new Map<string, number>()

  function grant(tabId: string, abs: string): void {
    grants.delete(`${tabId}\0${abs}`)
    grants.set(`${tabId}\0${abs}`, now())
    while (grants.size > MAX_GRANTS) {
      const first = grants.keys().next().value
      if (first === undefined) break
      grants.delete(first)
    }
  }

  function knowsRemote(tabId: string, abs: string): boolean {
    const at = grants.get(`${tabId}\0${abs}`)
    return at !== undefined && now() - at <= GRANT_TTL_MS
  }

  function mayReadRemote(tabId: string, cwd: string, path: string): boolean {
    return path.startsWith('/') && (insideRemote(path, cwd) || knowsRemote(tabId, posix.normalize(path)))
  }

  return {
    /** filesResolve of a server chat: one fs.stat for the lot. */
    async resolveRemote(tabId: string, cwd: string, hostId: string, raws: string[]): Promise<Array<ResolvedPath | null>> {
      const split = raws.map((raw) => ({ raw, ...splitLineSuffix(raw) }))
      let answers: Array<{ abs: string; kind: 'file' | 'dir' } | null>
      try {
        const client = await deps.client(hostId)
        answers = await client.call('fs.stat', { cwd, paths: split.map((s) => s.path) })
      } catch {
        return raws.map(() => null)
      }
      return split.map((s, i) => {
        const found = Array.isArray(answers) ? answers[i] : null
        if (!found || typeof found.abs !== 'string') return null
        grant(tabId, posix.normalize(found.abs))
        const out: ResolvedPath = { raw: s.raw, absPath: found.abs, isDir: found.kind === 'dir' }
        if (s.line !== undefined) out.line = s.line
        if (s.column !== undefined) out.column = s.column
        return out
      })
    },

    /** viewerRead: the window says where from; main decides whether it may. */
    async read(sourceRaw: unknown, tabId: unknown, path: unknown): Promise<ViewerContent> {
      const source = readSource(sourceRaw)
      if (!source || typeof tabId !== 'string' || !isPath(path)) return error('неверный запрос')
      const tab = deps.tab(tabId)
      if (!tab) return error('нет такого чата')
      if (source.kind === 'local') {
        if (tab.server) return error('это чат на сервере')
        if (!isAbsolute(path)) return error('путь не абсолютный')
        if (!insideLocal(path, tab.cwd) && !deps.knowsLocal(path, tabId)) return error('этот файл не из этого чата')
        return readLocal(path)
      }
      if (!tab.server || tab.server.hostId !== source.hostId) return error('чужой сервер')
      if (!mayReadRemote(tabId, tab.cwd, path)) return error('этот файл не из этого чата')
      try {
        return await readRemote(await deps.client(source.hostId), path)
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },

    /** viewerDownloadOpen: a server file, brought here and opened with its program. */
    async downloadOpen(tabId: unknown, path: unknown): Promise<'opened' | 'revealed' | null> {
      if (typeof tabId !== 'string' || !isPath(path)) return null
      const tab = deps.tab(tabId)
      if (!tab?.server || !mayReadRemote(tabId, tab.cwd, path)) return null
      try {
        const local = await downloadRemote(await deps.client(tab.server.hostId), tab.server.hostId, path, deps.userData)
        return await deps.openPath(local)
      } catch {
        return null
      }
    },

    /** A closed tab's server paths stop working. */
    forget(tabId: string): void {
      for (const key of [...grants.keys()]) if (key.startsWith(`${tabId}\0`)) grants.delete(key)
    }
  }
}

export type ViewerAccess = ReturnType<typeof viewerAccess>
