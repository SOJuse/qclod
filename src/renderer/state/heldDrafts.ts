import { create } from 'zustand'
import { isAfterHang } from '../../shared/reloadReason'

/**
 * A long draft that may have frozen the window (task 9b). When the watchdog
 * reloads a hung page (main/window.ts), the drafts come back from
 * sessionStorage (uiPersist.ts) — and a long one, put straight back into the
 * field, could freeze the new page too, until the watchdog gives up and the
 * window stays grey. So after such a reload a draft longer than LONG_DRAFT is
 * held back: the field starts empty, a strip above it offers the draft again
 * («Вставить»), and the draft itself is kept here, in its own sessionStorage
 * entry, until it is put back. Nothing is dropped.
 */
export const LONG_DRAFT = 20_000
export const HELD_KEY = 'qclod.held'

type Drafts = Record<string, string>

/**
 * Drafts longer than LONG_DRAFT move from `drafts` to `held`, after whatever
 * was held there already. A draft the held one already ends with is the stale
 * copy in the window's saved state (nothing changed since the last hang
 * reload, so qclod.ui was not rewritten): it is not added a second time.
 */
export function holdLongDrafts(drafts: Drafts, held: Drafts): { drafts: Drafts; held: Drafts } {
  const keep: Drafts = {}
  const out: Drafts = { ...held }
  for (const [id, text] of Object.entries(drafts)) {
    if (text.length <= LONG_DRAFT) keep[id] = text
    else if (out[id]?.endsWith(text)) continue
    else out[id] = out[id] ? `${out[id]}\n\n${text}` : text
  }
  return { drafts: keep, held: out }
}

export function loadHeld(storage: Pick<Storage, 'getItem'> | null): Drafts {
  const out: Drafts = {}
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(HELD_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
    for (const [id, text] of Object.entries(parsed)) if (typeof text === 'string' && text !== '') out[id] = text
  } catch {
    return {}
  }
  return out
}

export function saveHeld(storage: Pick<Storage, 'setItem'> | null, held: Drafts): void {
  try {
    storage?.setItem(HELD_KEY, JSON.stringify(held))
  } catch {
    // Storage full or blocked: the held draft lives as long as this page.
  }
}

/**
 * The drafts a page starts with, and the ones held back. `search` is the
 * page's location.search: `?reloaded=hang` after the watchdog's reload.
 */
export function restoreDrafts(
  drafts: Drafts,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  search: string
): { drafts: Drafts; held: Drafts } {
  const before = loadHeld(storage)
  if (isAfterHang(search)) {
    const out = holdLongDrafts(drafts, before)
    saveHeld(storage, out.held)
    return out
  }
  // A reload before the field changed still finds the held draft in the
  // window's saved state: it stays held rather than coming back twice.
  const keep: Drafts = {}
  for (const [id, text] of Object.entries(drafts)) {
    if (!(text.length > LONG_DRAFT && before[id]?.endsWith(text))) keep[id] = text
  }
  return { drafts: keep, held: before }
}

interface HeldState {
  byTab: Drafts
  /** The tab's held draft, now no longer held. */
  take: (tabId: string) => string | undefined
}

export const useHeldDrafts = create<HeldState>((set, get) => ({
  byTab: {},
  take: (tabId) => {
    const text = get().byTab[tabId]
    if (text === undefined) return undefined
    const { [tabId]: _taken, ...rest } = get().byTab
    set({ byTab: rest })
    return text
  }
}))

/**
 * Called once as the store starts: returns the drafts for the fields and
 * keeps the held ones here, saved on every change. The reload marker is taken
 * off the address, so a later Ctrl+R is an ordinary reload.
 */
export function startHeldDrafts(drafts: Drafts, storage: Storage | null): Drafts {
  const search = typeof location === 'undefined' ? '' : location.search
  const out = restoreDrafts(drafts, storage, search)
  useHeldDrafts.setState({ byTab: out.held })
  useHeldDrafts.subscribe((state, before) => {
    if (state.byTab !== before.byTab) saveHeld(storage, state.byTab)
  })
  if (isAfterHang(search)) {
    try {
      history.replaceState(history.state, '', location.pathname + location.hash)
    } catch {
      // The marker stays; a Ctrl+R would hold the draft back again, nothing worse.
    }
  }
  return out.drafts
}
