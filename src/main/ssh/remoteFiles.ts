import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RelayMethod } from '../../shared/relayProtocol'
import type { ViewerContent } from '../../shared/types'
import { toViewerContent, viewerLimit } from '../files/viewer'

/** fs.read takes at most this much per call (the relay's READ_MAX). */
export const READ_CHUNK = 256 * 1024
/** A server file brought here to open with a program. */
export const DOWNLOAD_MAX = 100 * 1024 * 1024
export const REMOTE_FILES_DIR = 'remote-files'
/** Downloads are kept a day: «Скачать и открыть» again within it reads anew anyway. */
const KEEP_MS = 24 * 60 * 60 * 1000

/** What reading a server file needs of the relay channel (RelayClient has it). */
export interface RelayReader {
  call<T>(m: RelayMethod, p: unknown, o?: { timeoutMs?: number }): Promise<T>
}

interface Chunk {
  dataBase64: string
  size: number
  eof: boolean
}

/** Up to `limit` bytes of a server file, in 256 KiB reads, and its whole size. */
async function readUpTo(client: RelayReader, path: string, limit: number): Promise<{ data: Buffer; size: number }> {
  const parts: Buffer[] = []
  let offset = 0
  let size = 0
  for (;;) {
    const length = Math.min(READ_CHUNK, limit - offset)
    const chunk = await client.call<Chunk>('fs.read', { path, offset, length: Math.max(0, length) })
    const piece = Buffer.from(chunk.dataBase64, 'base64')
    size = chunk.size
    parts.push(piece)
    offset += piece.length
    if (chunk.eof || piece.length === 0 || offset >= limit) break
  }
  return { data: Buffer.concat(parts), size }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A server file for the viewer: a whole picture, the start of a text, never more than the viewer shows. */
export async function readRemote(client: RelayReader, path: string): Promise<ViewerContent> {
  try {
    // One byte more than the limit says whether the text was cut.
    const { data, size } = await readUpTo(client, path, viewerLimit(path) + 1)
    return toViewerContent(path, data, size)
  } catch (error) {
    return { kind: 'error', message: message(error) }
  }
}

/** A host id as a folder name: what is not plainly safe is hashed. */
function hostFolder(hostId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(hostId) ? hostId : createHash('sha1').update(hostId).digest('hex')
}

/** The file's name, made safe for this machine's disk. */
function localName(path: string): string {
  // A server path is POSIX; a backslash in a name is rarer than a test on Windows.
  const base = (path.split(/[\\/]/).pop() ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
  return base === '' ? 'file' : base.slice(0, 200)
}

/**
 * A server file brought to userData/remote-files/<hostId>/<sha1(path)>/<name>,
 * written aside and renamed into place. Returns the local path; the caller
 * opens it through openPath (a runnable file is shown, never run).
 */
export async function downloadRemote(client: RelayReader, hostId: string, path: string, userData: string): Promise<string> {
  const { data, size } = await readUpTo(client, path, DOWNLOAD_MAX + 1)
  if (size > DOWNLOAD_MAX) throw new Error('Файл больше 100 МБ — скачивать не стану')
  const dir = join(userData, REMOTE_FILES_DIR, hostFolder(hostId), createHash('sha1').update(path).digest('hex'))
  mkdirSync(dir, { recursive: true })
  const target = join(dir, localName(path))
  const part = `${target}.part`
  writeFileSync(part, data)
  rmSync(target, { force: true })
  renameSync(part, target)
  return target
}

/** Downloads older than a day go (по образцу cleanupPasteDir): at start and every hour. */
export function cleanupRemoteFiles(userData: string, now = Date.now()): void {
  const root = join(userData, REMOTE_FILES_DIR)
  let hosts: string[]
  try {
    hosts = readdirSync(root)
  } catch {
    return
  }
  for (const host of hosts) {
    let files: string[]
    try {
      files = readdirSync(join(root, host))
    } catch {
      continue
    }
    for (const name of files) {
      const dir = join(root, host, name)
      try {
        if (now - statSync(dir).mtimeMs > KEEP_MS) rmSync(dir, { recursive: true, force: true })
      } catch {
        // Open in a program right now: next time.
      }
    }
  }
}
