import type { TabId, TabState } from '../../shared/types'

/** How long a just-opened chat may take to appear in the tab list before the drop is given up. */
export const KNOWN_WAIT_MS = 5000

/** The part of the store this needs: the tab list, read and watched. */
export interface TabsSource {
  getState: () => { tabs: TabState[] }
  subscribe: (listener: (state: { tabs: TabState[] }) => void) => () => void
}

/** True once `id` is in the tab list (at once if it already is), false after `ms`. */
export function whenTabKnown(store: TabsSource, id: TabId, ms: number): Promise<boolean> {
  const known = (state: { tabs: TabState[] }): boolean => state.tabs.some((t) => t.id === id)
  if (known(store.getState())) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(false)
    }, ms)
    const off = store.subscribe((state) => {
      if (!known(state)) return
      clearTimeout(timer)
      off()
      resolve(true)
    })
  })
}

export type DropSessionResult = 'placed' | 'none' | 'lost' | 'failed'

/**
 * A past conversation let go on the split: main opens it (or names the chat
 * that already holds it), and only once that chat is in the tab list is it
 * put where it was dropped. Main's answer and its tab list come by different
 * messages, in either order; a chat placed before the list knows it would be
 * dropped from the row by the first list without it.
 *
 * - `none`: main opened nothing.
 * - `lost`: the chat never showed up in the list within `waitMs`.
 * - `failed`: the opening itself failed; the reason is logged.
 */
export async function openAndPlace(opts: {
  store: TabsSource
  open: () => Promise<TabState | null>
  place: (id: TabId) => void
  waitMs?: number
}): Promise<DropSessionResult> {
  let tab: TabState | null
  try {
    tab = await opts.open()
  } catch (err) {
    console.warn('[split] разговор не открылся:', err instanceof Error ? err.message : String(err))
    return 'failed'
  }
  if (!tab) return 'none'
  if (!(await whenTabKnown(opts.store, tab.id, opts.waitMs ?? KNOWN_WAIT_MS))) {
    console.warn('[split] открытый чат не появился в списке, в ряд не поставлен:', tab.id)
    return 'lost'
  }
  opts.place(tab.id)
  return 'placed'
}
