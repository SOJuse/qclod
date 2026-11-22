import type { Attachment, PreparedImage } from '../../shared/types'

/**
 * An image before it is sent. It comes as a `file` from the clipboard; main
 * then bounds it and saves a copy (`prepared`), or says why it cannot
 * (`error`). A restored draft has only `prepared`, without the bytes.
 */
export interface PendingImage {
  kind: 'image'
  mediaType: string
  file?: File
  prepared?: PreparedImage
  error?: string
}

/**
 * A file before it is sent. In a server chat (stage 6) it is uploaded at once:
 * `uploading` while it goes, then `remotePath` — its path on the server, which
 * the message carries — or `error`, and it does not go.
 */
export interface PendingFile {
  kind: 'file'
  path: string
  uploading?: true
  remotePath?: string
  error?: string
}

/** An attachment before it is sent: a path on disk, or an image. */
export type PendingAttachment = PendingFile | PendingImage

/** What the chip says while a file goes to the server. */
export const UPLOADING_TEXT = 'загружаю на сервер…'

/** main's answer for a file of a server chat: its path there, or why not. */
export type UploadRemote = (path: string) => Promise<{ remotePath: string } | { error: string }>

/**
 * A server chat's file, uploaded: the chip keeps its local path (what the
 * person sees) and gets the server's path, or the error — and an errored one
 * is never sent (materialize).
 */
export async function prepareRemoteFile(
  item: { kind: 'file'; path: string },
  upload: UploadRemote
): Promise<PendingAttachment> {
  try {
    const out = await upload(item.path)
    if ('error' in out) return { kind: 'file', path: item.path, error: out.error }
    return { kind: 'file', path: item.path, remotePath: out.remotePath }
  } catch (e) {
    return {
      kind: 'file',
      path: item.path,
      error: `Не удалось загрузить на сервер: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

/** A server chat's file chip that has not started its upload. */
export function needsUpload(item: PendingAttachment): item is PendingFile {
  return item.kind === 'file' && !item.uploading && item.remotePath === undefined && item.error === undefined
}

/** main's answer for an image: the bounded copy, or why there is none. */
export type PrepareImage = (dataBase64: string, mediaType: string) => Promise<PreparedImage | { error: string }>

/** Electron's webUtils, as the preload bridge exposes it. */
export type ResolvePath = (file: File) => string | null

function isImage(file: File): boolean {
  return file.type.startsWith('image/')
}

/**
 * What the user just pasted.
 *
 * This is the fix for the bug that travelled here from v1 (spec 6.6): a file
 * copied in Explorer arrives in `clipboardData.files` with no text at all, so
 * a handler that reads only `text/plain` and images does nothing whatsoever —
 * the user pressed Ctrl+V and the app simply ignored them.
 *
 * Images go by content rather than by path: the clipboard's image has no file
 * on disk, and the SDK takes image blocks directly (spec 6.3).
 */
export function attachmentsFromClipboard(
  data: DataTransfer | null,
  resolvePath: ResolvePath
): PendingAttachment[] {
  if (!data) return []

  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile?.() ?? null)
    .filter((file): file is File => file !== null)

  const images: PendingAttachment[] = fromItems.map((file) => ({
    kind: 'image',
    mediaType: file.type || 'image/png',
    file
  }))
  if (images.length > 0) return images

  return attachmentsFromDrop(Array.from(data.files ?? []), resolvePath)
}

/**
 * What the user just dropped on the window.
 *
 * A file with a path on disk goes as a path — including an image, since the
 * agent can read it where it lies. Only something with no path left (an image
 * dragged out of a browser, say) travels as content.
 */
export function attachmentsFromDrop(
  files: readonly File[],
  resolvePath: ResolvePath
): PendingAttachment[] {
  const out: PendingAttachment[] = []
  for (const file of files) {
    const path = resolvePath(file)
    if (path) {
      out.push({ kind: 'file', path })
      continue
    }
    // No path and not an image: there is nothing to attach. Inserting the bare
    // file name would point the agent at a file that is not there.
    if (isImage(file)) out.push({ kind: 'image', mediaType: file.type || 'image/png', file })
  }
  return out
}

/** An image main has not answered for yet: the message waits for it. */
export function isPreparing(item: PendingAttachment): boolean {
  // A file still going to the server (stage 6) is waited for the same way.
  if (item.kind === 'file') return item.uploading === true
  return item.prepared === undefined && item.error === undefined
}

/**
 * Hands a pasted image to main, which scales a large screenshot down to what
 * the API accepts, makes the thumbnail and keeps a copy in userData/pastes.
 */
export async function prepareAttachment(
  item: PendingImage,
  prepare: PrepareImage
): Promise<Pick<PendingImage, 'prepared' | 'error'>> {
  const unreadable = { error: 'Не получилось прочитать картинку' }
  if (!item.file) return unreadable
  const dataBase64 = await readAsBase64(item.file)
  if (!dataBase64) return unreadable
  try {
    const out = await prepare(dataBase64, item.mediaType)
    return 'error' in out ? { error: out.error } : { prepared: out }
  } catch {
    return unreadable
  }
}

/**
 * What goes to main. An image goes as main prepared it; one with an error, or
 * still being prepared, does not go at all. The window never holds an image's
 * bytes: the path of its copy stands for them and main reads the file.
 */
export function materialize(pending: PendingAttachment[]): Attachment[] {
  const out: Attachment[] = []
  for (const item of pending) {
    if (item.kind === 'file') {
      // A server chat's file goes as its path there; one that failed or is still going, not at all.
      if (item.error !== undefined || item.uploading) continue
      out.push({ kind: 'file', path: item.remotePath ?? item.path })
      continue
    }
    const prepared = item.prepared
    if (!prepared) continue
    out.push({
      kind: 'image',
      mediaType: prepared.mediaType,
      dataBase64: '',
      path: prepared.path,
      thumbnail: prepared.thumbnail,
      width: prepared.width,
      height: prepared.height
    })
  }
  return out
}

/**
 * What a send that waited for an image does once something changes: keep
 * waiting while an image is being prepared; send when every image is ready;
 * otherwise cancel — an image failed (the message must not quietly go
 * without it), the image it waited for was taken away, or the tab's session
 * died meanwhile (the text stays in the field).
 */
export function queuedSendStep(
  queued: boolean,
  attachments: PendingAttachment[],
  dead = false
): 'none' | 'wait' | 'send' | 'cancel' {
  if (!queued) return 'none'
  if (dead) return 'cancel'
  if (attachments.some(isPreparing)) return 'wait'
  // What a send can have waited for: an image, or a file uploaded to the server.
  const waited = attachments.filter((a) => a.kind === 'image' || a.remotePath !== undefined || a.error !== undefined)
  if (waited.length === 0 || waited.some((a) => a.error !== undefined)) return 'cancel'
  return 'send'
}

/**
 * A message's attachment back as a chip — what «Стоп» hands back from the
 * queue. A file goes back as its path; an image as the copy main made of it
 * (`prepared`), with its bytes as a `File` when they came along. An image
 * with neither cannot be sent again and says so.
 */
export function pendingFromSent(attachment: Attachment): PendingAttachment {
  if (attachment.kind === 'file') return { kind: 'file', path: attachment.path }
  const { mediaType, dataBase64, path } = attachment
  const file = dataBase64 ? fileFromBase64(dataBase64, mediaType) : undefined
  if (!path) {
    return file
      ? { kind: 'image', mediaType, file }
      : { kind: 'image', mediaType, error: 'Не получилось прочитать картинку' }
  }
  return {
    kind: 'image',
    mediaType,
    ...(file ? { file } : {}),
    prepared: {
      mediaType,
      thumbnail: attachment.thumbnail ?? '',
      path,
      width: attachment.width ?? 0,
      height: attachment.height ?? 0
    }
  }
}

function fileFromBase64(dataBase64: string, mediaType: string): File | undefined {
  try {
    const binary = atob(dataBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], 'снимок', { type: mediaType })
  } catch {
    return undefined
  }
}

/**
 * The input field once «Стоп» has handed the queue back: the messages that
 * were waiting, in order and a blank line apart, before whatever is already
 * typed.
 */
export function draftWithReturned(texts: string[], draft: string): string {
  return [...texts, draft].filter((text) => text.trim() !== '').join('\n\n')
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => resolve('')
    reader.readAsDataURL(file)
  })
}

/** What the chip in the composer says. */
export function attachmentLabel(item: PendingAttachment): string {
  if (item.kind === 'image') {
    const p = item.prepared
    if (p) return p.width > 0 && p.height > 0 ? `Снимок ${p.width}×${p.height}` : 'Снимок'
    return item.error ?? 'Готовлю снимок…'
  }
  const name = item.path.split(/[\\/]/).pop() ?? item.path
  if (item.error !== undefined) return item.error
  if (item.uploading) return `${name} — ${UPLOADING_TEXT}`
  return name
}
