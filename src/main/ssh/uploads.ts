import { open, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { RelayReader } from './remoteFiles'

export const UPLOAD_CHUNK = 256 * 1024
export const UPLOAD_MAX = 100 * 1024 * 1024
export const UPLOAD_TOO_LARGE_TEXT = 'Файл больше 100 МБ — на сервер не загружается'
export const uploadFailedText = (why: string): string => `Не удалось загрузить на сервер: ${why}`

/**
 * A local file into the server chat's uploads (~/.qclod/uploads/<s>/), in
 * 256 KiB chunks, the last one `final`. Too large a file is refused before a
 * single request. Returns the file's path on the server — what the message
 * mentions instead of the local one (decision 8).
 */
export async function uploadFile(
  client: RelayReader,
  s: string,
  localPath: string,
  onProgress?: (sent: number, total: number) => void
): Promise<string> {
  if (!isAbsolute(localPath)) throw new Error('путь не абсолютный')
  const info = await stat(localPath)
  if (!info.isFile()) throw new Error('это не файл')
  if (info.size > UPLOAD_MAX) throw new Error(UPLOAD_TOO_LARGE_TEXT)
  const name = basename(localPath)
  const handle = await open(localPath, 'r')
  try {
    let offset = 0
    let path = ''
    const buffer = Buffer.alloc(UPLOAD_CHUNK)
    do {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(UPLOAD_CHUNK, info.size - offset), offset)
      const final = offset + bytesRead >= info.size || bytesRead === 0
      // Every chunk after the first names the file the first one made: two files
      // of one name uploaded side by side never land in one.
      const answer = await client.call<{ path: string }>('fs.upload', {
        s,
        name,
        offset,
        dataBase64: buffer.subarray(0, bytesRead).toString('base64'),
        final,
        ...(offset > 0 ? { path } : {})
      })
      path = answer.path
      offset += bytesRead
      onProgress?.(offset, info.size)
      if (final) break
    } while (offset < info.size)
    return path
  } finally {
    await handle.close()
  }
}

/** How long a server chat's @-list is kept before it is asked again. */
export const REMOTE_INDEX_TTL_MS = 60_000

/** The @-list of server chats: fs.index of the chat's folder, kept a minute per tab. */
export class RemoteIndexCache {
  private readonly kept = new Map<string, { at: number; files: string[] }>()
  constructor(private readonly now: () => number = Date.now) {}

  async files(client: () => Promise<RelayReader>, tabId: string, root: string, limit: number): Promise<string[]> {
    const hit = this.kept.get(tabId)
    if (hit && this.now() - hit.at < REMOTE_INDEX_TTL_MS) return hit.files
    const answer = await (await client()).call<{ files: string[]; truncated: boolean }>('fs.index', { root, limit })
    const files = Array.isArray(answer.files) ? answer.files.filter((f) => typeof f === 'string') : []
    this.kept.set(tabId, { at: this.now(), files })
    return files
  }

  forget(tabId: string): void {
    this.kept.delete(tabId)
  }
}
