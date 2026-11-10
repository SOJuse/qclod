import type { PendingAttachment } from '../input/attachments'

/**
 * What a reloaded window gets back (Ctrl+R): drafts, attachments by path, the
 * second pane and the active tab. It lives in sessionStorage: it survives a
 * reload and goes with the window, and a closed tab's entry is dropped when
 * the store forgets the tab.
 *
 * Only paths and text are kept. A pasted image has no file on disk and its
 * bytes are not written anywhere, so it does not come back.
 */
export const UI_KEY = 'qclod.ui'

export interface PersistedUi {
  draftByTab: Record<string, string>
  attachmentsByTab: Record<string, PendingAttachment[]>
  splitTabId: string | null
  activeTabId: string
}

const EMPTY = (): PersistedUi => ({ draftByTab: {}, attachmentsByTab: {}, splitTabId: null, activeTabId: '' })

export function serializeUi(state: PersistedUi): string {
  const draftByTab: Record<string, string> = {}
  for (const [id, text] of Object.entries(state.draftByTab)) if (text !== '') draftByTab[id] = text
  const attachmentsByTab: Record<string, PendingAttachment[]> = {}
  for (const [id, items] of Object.entries(state.attachmentsByTab)) {
    const files = items.filter((item) => item.kind === 'file')
    if (files.length > 0) attachmentsByTab[id] = files
  }
  return JSON.stringify({
    draftByTab,
    attachmentsByTab,
    splitTabId: state.splitTabId,
    activeTabId: state.activeTabId
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
        const files = items.filter(
          (item): item is { kind: 'file'; path: string } =>
            isRecord(item) && item['kind'] === 'file' && typeof item['path'] === 'string'
        )
        if (files.length > 0) out.attachmentsByTab[id] = files.map((f) => ({ kind: 'file', path: f.path }))
      }
    }
    if (typeof parsed['splitTabId'] === 'string') out.splitTabId = parsed['splitTabId']
    if (typeof parsed['activeTabId'] === 'string') out.activeTabId = parsed['activeTabId']
  } catch {
    return EMPTY()
  }
  return out
}
