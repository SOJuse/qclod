import type { Attachment } from '../../shared/types'

/**
 * An attachment before it is read: either a path on disk, or a file whose
 * bytes still have to be loaded.
 */
export type PendingAttachment =
  | { kind: 'file'; path: string }
  | { kind: 'image'; mediaType: string; file: File }

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

/** Reads the bytes of anything that has to travel as content. */
export async function materialize(pending: PendingAttachment[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const item of pending) {
    if (item.kind === 'file') {
      out.push({ kind: 'file', path: item.path })
      continue
    }
    const dataBase64 = await readAsBase64(item.file)
    if (dataBase64) out.push({ kind: 'image', mediaType: item.mediaType, dataBase64 })
  }
  return out
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
  if (item.kind === 'image') return item.file.name || 'изображение'
  return item.path.split(/[\\/]/).pop() ?? item.path
}
