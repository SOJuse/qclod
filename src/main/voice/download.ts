import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManifestFile } from './manifest'

export type DownloadErrorCode = 'network' | 'checksum' | 'disk' | 'aborted' | 'extract' | 'access'

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'DownloadError'
  }
}

export interface DownloadDeps {
  fetch: typeof fetch
  signal?: AbortSignal
  /** Bytes of this file so far, resumed part included. */
  onBytes(total: number): void
  /** No byte for this long: the connection is dead, the next address is tried (M5). 60 s. */
  idleMs?: number
}

const IDLE_MS = 60_000

function isAccessError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'EACCES' || code === 'EPERM'
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function hashFile(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
}

/** SHA-256 of a whole file, lower-case hex. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await hashFile(path, hash)
  return hash.digest('hex')
}

class Mismatch extends Error {}

/**
 * <dir>/<name>.part, resumed with Range; SHA-256 is computed on the fly (on a
 * resume — first over the part already there). A mismatch restarts from zero at
 * the next address; at the end the part is renamed.
 */
export async function fetchFile(file: ManifestFile, dir: string, deps: DownloadDeps): Promise<void> {
  await mkdir(dir, { recursive: true })
  const final = join(dir, file.name)
  const part = `${final}.part`
  const sig = deps.signal
  const aborted = (): DownloadError => new DownloadError('aborted')
  let last: DownloadError = new DownloadError('network')

  for (const url of file.urls) {
    if (sig?.aborted) throw aborted()
    try {
      await attempt(url)
      return
    } catch (err) {
      if (sig?.aborted) throw aborted()
      if (err instanceof Mismatch) {
        await rm(part, { force: true })
        last = new DownloadError('checksum')
      } else if (err instanceof DownloadError) {
        throw err
      } else if (isAccessError(err)) {
        // The folder is not ours to write: another address will not help (M4).
        throw new DownloadError('access', (err as Error).message)
      } else {
        last = new DownloadError('network', (err as Error)?.message)
      }
    }
  }
  throw last

  async function attempt(url: string): Promise<void> {
    let have = await sizeOf(part)
    if (have > file.size) {
      await rm(part, { force: true })
      have = 0
    }
    let hash = createHash('sha256')
    if (have > 0) await hashFile(part, hash)

    if (have < file.size) {
      const headers: Record<string, string> = {}
      if (have > 0) headers['Range'] = `bytes=${have}-`
      // A connection that stays open with nothing coming would hang the download for ever.
      const idleMs = deps.idleMs ?? IDLE_MS
      const idle = new AbortController()
      let idleTimer = setTimeout(() => idle.abort(), idleMs)
      const poke = (): void => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => idle.abort(), idleMs)
      }
      const signal = sig ? AbortSignal.any([sig, idle.signal]) : idle.signal
      let handle: FileHandle | null = null
      try {
        const res = await deps.fetch(url, { headers, signal, redirect: 'follow' })
        poke()
        if (res.status === 416) {
          // Nothing left to send: what we have is judged by its sum below.
        } else if (res.status === 200 || res.status === 206) {
          if (res.status === 200 && have > 0) {
            // The server ignored Range: start over.
            have = 0
            hash = createHash('sha256')
          }
          handle = await open(part, have > 0 ? 'a' : 'w')
          if (have === 0) await handle.truncate(0)
          if (!res.body) throw new Error('empty body')
          deps.onBytes(have)
          const reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            poke()
            hash.update(value)
            try {
              await handle.write(value)
            } catch (e) {
              if (isAccessError(e)) throw new DownloadError('access', (e as Error).message)
              throw new DownloadError('disk', (e as Error).message ? 'disk' : undefined)
            }
            have += value.length
            deps.onBytes(have)
            if (have > file.size) throw new Mismatch()
          }
        } else {
          throw new Error(`HTTP ${res.status}`)
        }
      } catch (err) {
        if (idle.signal.aborted && !sig?.aborted) throw new Error(`no data for ${Math.round(idleMs / 1000)} s`)
        throw err
      } finally {
        clearTimeout(idleTimer)
        await handle?.close()
      }
    }

    if (have !== file.size || hash.digest('hex') !== file.sha256.toLowerCase()) {
      // A short body is a broken connection, not a bad file: keep the part for a resume.
      if (have < file.size && (await sizeOf(part)) === have) throw new Error('connection closed early')
      throw new Mismatch()
    }
    await rename(part, final)
  }
}
