import type { PendingAttachment, PendingImage } from '../input/attachments'

/**
 * What a reloaded window gets back (Ctrl+R): drafts and attachments by path.
 * The panes and the active chat are main's (layout.json). It lives in sessionStorage: it survives a
 * reload and goes with the window, and a closed tab's entry is dropped when
 * the store forgets the tab.
 *
 * Only paths and text are kept. A pasted image comes back by its copy in
 * userData/pastes: its thumbnail and path, without the bytes, which main reads
 * from that file when the message goes. One still being prepared, or one that
 * failed, does not come back.
 */
export const UI_KEY = 'qclod.ui'

export interface PersistedUi {
  draftByTab: Record<string, string>
  attachmentsByTab: Record<string, PendingAttachment[]>
}

const EMPTY = (): PersistedUi => ({ draftByTab: {}, attachmentsByTab: {} })

export function serializeUi(state: PersistedUi): string {
  const draftByTab: Record<string, string> = {}
  for (const [id, text] of Object.entries(state.draftByTab)) if (text !== '') draftByTab[id] = text
  const attachmentsByTab: Record<string, PendingAttachment[]> = {}
  for (const [id, items] of Object.entries(state.attachmentsByTab)) {
    const kept: PendingAttachment[] = []
    for (const item of items) {
      if (item.kind === 'file') kept.push(item)
      else if (item.prepared) kept.push(restorable(item.prepared))
    }
    if (kept.length > 0) attachmentsByTab[id] = kept
  }
  return JSON.stringify({ draftByTab, attachmentsByTab })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A prepared image as it is kept: what main answered, without the pasted File. */
function restorable(prepared: NonNullable<PendingImage['prepared']>): PendingImage {
  const { mediaType, thumbnail, path, width, height } = prepared
  return { kind: 'image', mediaType, prepared: { mediaType, thumbnail, path, width, height } }
}

/** A side in pixels; 0 is a GIF or WebP whose size was never read. */
function isSide(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function restoredImage(item: Record<string, unknown>): PendingImage | null {
  const p = item['prepared']
  if (!isRecord(p)) return null
  const { mediaType, path, thumbnail, width, height } = p
  if (typeof mediaType !== 'string' || typeof path !== 'string' || path === '') return null
  // No thumbnail at all, or an inline picture; never something to fetch.
  if (typeof thumbnail !== 'string' || (thumbnail !== '' && !thumbnail.startsWith('data:image/'))) return null
  if (!isSide(width) || !isSide(height)) return null
  return restorable({ mediaType, path, thumbnail, width, height })
}

export function loadUi(storage: Pick<Storage, 'getItem'> | null): PersistedUi {
  const out = EMPTY()
  try {
    const raw = storage?.getItem(UI_KEY)
    if (!raw) return out
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return out
    if (isRecord(parsed['draftByTab'])) {
      for (const [id, text] of Object.entries(parsed['draftByTab'])) {
        if (typeof text === 'string' && text !== '') out.draftByTab[id] = text
      }
    }
    if (isRecord(parsed['attachmentsByTab'])) {
      for (const [id, items] of Object.entries(parsed['attachmentsByTab'])) {
        if (!Array.isArray(items)) continue
        const kept: PendingAttachment[] = []
        for (const item of items) {
          if (!isRecord(item)) continue
          if (item['kind'] === 'file' && typeof item['path'] === 'string') {
            kept.push({ kind: 'file', path: item['path'] })
          } else if (item['kind'] === 'image') {
            const image = restoredImage(item)
            if (image) kept.push(image)
          }
        }
        if (kept.length > 0) out.attachmentsByTab[id] = kept
      }
    }
  } catch {
    return EMPTY()
  }
  return out
}
