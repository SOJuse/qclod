import type { QclodApi } from '../../preload'
import type { LayoutState } from '../../shared/types'
import type { useAppStore } from './useAppStore'

const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Keeps the window's layout and main's together. Main's answer is taken as it
 * comes; the window's own pane changes go back as one write after a quiet
 * moment. What main last said is remembered apart, and a change that equals it
 * is never written, so the echo of the window's own write ends the exchange.
 *
 * - Nothing is written before main's first answer is in: until then the
 *   window's panes are a guess made from the tab list.
 * - Pane ids main names that the tab list does not hold yet are not a change:
 *   the saved split waits for them instead of being cut back.
 * - While a write is waiting or on its way, main's events bring their news
 *   (an activation, say) but not their older panes. When the write settles,
 *   whichever way, the two are compared again: main's panes are taken if the
 *   user has not changed them since, otherwise the write is armed again.
 */
export function startLayoutSync(
  store: Pick<typeof useAppStore, 'getState' | 'subscribe'>,
  api: Pick<QclodApi, 'getLayout' | 'setLayout' | 'onLayoutChanged'>,
  debounceMs = 300
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = 0
  let stopped = false
  let ready = false
  let lastMain: LayoutState = store.getState().layout
  let sent: { panes: readonly string[]; widths: readonly number[] } | null = null

  const differs = (): boolean => {
    const s = store.getState()
    const known = new Set(s.tabs.map((t) => t.id))
    const expected = lastMain.panes.filter((id) => known.has(id))
    if (!same(s.paneTabIds, expected)) return true
    // The shares of panes that are not all here yet mean nothing.
    return expected.length === lastMain.panes.length && !same(s.paneWidths, lastMain.paneWidths)
  }
  const arm = (): void => {
    clearTimeout(timer)
    timer = ready && differs() ? setTimeout(flush, debounceMs) : undefined
  }
  const flush = (): void => {
    timer = undefined
    if (stopped || !ready || !differs()) return
    const { paneTabIds, paneWidths } = store.getState()
    sent = { panes: paneTabIds, widths: paneWidths }
    inFlight++
    api
      .setLayout({ panes: paneTabIds, paneWidths })
      .catch((err: unknown) => console.warn('[layout] write failed:', err))
      .finally(() => {
        inFlight--
        if (stopped || inFlight > 0 || timer !== undefined || !differs()) return
        const now = store.getState()
        if (sent && same(now.paneTabIds, sent.panes) && same(now.paneWidths, sent.widths)) {
          // The user has not touched the panes since: main's word stands.
          now.setLayout(lastMain)
        } else {
          arm()
        }
      })
  }
  const apply = (layout: LayoutState): void => {
    if (stopped) return
    lastMain = layout
    const state = store.getState()
    const writing = ready && (timer !== undefined || inFlight > 0)
    ready = true
    state.setLayout(writing ? { ...layout, panes: state.paneTabIds, paneWidths: state.paneWidths } : layout)
    arm()
  }

  api.getLayout().then(apply, (err: unknown) => console.warn('[layout] read failed:', err))
  const off = api.onLayoutChanged(apply)
  const unsubscribe = store.subscribe((state, before) => {
    if (state.paneTabIds === before.paneTabIds && state.paneWidths === before.paneWidths && state.tabs === before.tabs) return
    arm()
  })

  return () => {
    stopped = true
    clearTimeout(timer)
    unsubscribe()
    off()
  }
}
