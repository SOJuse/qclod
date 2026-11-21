import { ipcMain } from 'electron'
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { CHANNELS } from '../../shared/channels'
import type { ViewerFile } from '../../shared/viewerFile'

/** A file longer than this is shown by its head only. */
export const VIEWER_MAX_BYTES = 1024 * 1024

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Reads the head of a regular file; text only (a NUL in the first 8 KB makes it binary). */
export function readForViewerLocal(absPath: string): ViewerFile {
  let fd: number | null = null
  try {
    fd = openSync(absPath, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { kind: 'error', message: 'Это не файл.' }
    const want = Math.min(stat.size, VIEWER_MAX_BYTES)
    const buf = Buffer.alloc(want)
    const got = want > 0 ? readSync(fd, buf, 0, want, 0) : 0
    const head = buf.subarray(0, Math.min(got, 8192))
    if (head.includes(0)) return { kind: 'binary', size: stat.size }
    return { kind: 'text', text: buf.subarray(0, got).toString('utf8'), size: stat.size, truncated: stat.size > got }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'error', message: 'Не удалось прочитать файл.' }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * The viewer reads a file when the tab is open and the file is either one main
 * found for this tab in its text (`knows`) or lies inside the tab's folder
 * (the Git layer's «Весь файл»). A link out of the folder (symlink) does not pass.
 */
export function registerViewerReadIpc(deps: {
  tabs: () => Array<{ id: string; cwd: string }>
  knows: (absPath: string, tabId: string) => boolean
}): void {
  ipcMain.handle(CHANNELS.filesViewerRead, (_e, tabId: unknown, absPath: unknown): ViewerFile => {
    if (typeof tabId !== 'string' || typeof absPath !== 'string' || absPath === '' || absPath.length > 4096) {
      return { kind: 'error', message: 'Файл недоступен.' }
    }
    const tab = deps.tabs().find((t) => t.id === tabId)
    if (!tab || !isAbsolute(absPath)) return { kind: 'error', message: 'Файл недоступен.' }
    let ok = deps.knows(absPath, tabId)
    if (!ok) {
      try {
        ok = inside(realpathSync.native(resolve(tab.cwd)), realpathSync.native(absPath))
      } catch {
        return { kind: 'missing' }
      }
    }
    return ok ? readForViewerLocal(absPath) : { kind: 'error', message: 'Файл недоступен.' }
  })
}
