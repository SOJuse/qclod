export const PASTE_START = '[200~'
export const PASTE_END = '[201~'

/** 64 KiB per write keeps a huge paste from blocking the main thread. */
const DEFAULT_CHUNK = 64 * 1024

/**
 * Wraps text the way a terminal announces a paste. The CLI turns bracketed
 * paste mode on (probe note 2), so a multi-line block arrives as one input
 * instead of one submission per line.
 *
 * The CLI's TUI wants a carriage return for a line break inside a paste, and
 * any paste marker already present in the text is stripped — otherwise text
 * from the clipboard could end the block early and the tail would be executed
 * as input.
 */
export function encodeForPty(text: string): string {
  if (text === '') return ''
  const safe = text
    .split(PASTE_END)
    .join('')
    .split(PASTE_START)
    .join('')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r')
  return `${PASTE_START}${safe}${PASTE_END}`
}

/**
 * Same payload as `encodeForPty`, split into writable pieces. Markers are never
 * split across pieces, so a partially delivered paste still reads as a paste.
 */
export function chunkForPty(text: string, chunkSize: number = DEFAULT_CHUNK): string[] {
  const encoded = encodeForPty(text)
  if (encoded === '') return []

  const body = encoded.slice(PASTE_START.length, encoded.length - PASTE_END.length)
  const size = Math.max(1, chunkSize - PASTE_START.length)
  if (body.length <= size) return [encoded]

  const chunks: string[] = []
  for (let i = 0; i < body.length; i += size) {
    const piece = body.slice(i, i + size)
    chunks.push(
      (i === 0 ? PASTE_START : '') + piece + (i + size >= body.length ? PASTE_END : '')
    )
  }
  return chunks
}
