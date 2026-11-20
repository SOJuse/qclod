import type { QclodApi } from '../../preload'
import type { LayoutState } from '../../shared/types'
import type { useAppStore } from './useAppStore'

const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Keeps the window's layout and main's together. Main's answer is taken as it
 * comes; the window's own pane changes go back as one write after a quiet
 * moment. What main last said about panes and widths is remembered apart, and
 * a change that equals it is never written, so the echo of the window's own
 * write ends the exchange. While a write is waiting or on its way, main's
 * events (an activation, say) bring their news but not their older panes.
 */
export function startLayoutSync(
  store: Pick<typeof useAppStore, 'getState' | 'subscribe'>,
  api: Pick<QclodApi, 'getLayout' | 'setLayout' | 'onLayoutChanged'>,
  debounceMs = 300
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = 0
  let stopped = false
  let mainPanes: readonly string[] = store.getState().layout.panes
  let mainWidths: readonly number[] = store.getState().layout.paneWidths

  const differs = (): boolean => {
    const s = store.getState()
    return !same(s.paneTabIds, mainPanes) || !same(s.paneWidths, mainWidths)
  }
  const flush = (): void => {
    timer = undefined
    if (stopped || !differs()) return
    const { paneTabIds, paneWidths } = store.getState()
    inFlight++
    api
      .setLayout({ panes: paneTabIds, paneWidths })
      .catch((err: unknown) => console.warn('[layout] write failed:', err))
      .finally(() => {
        inFlight--
      })
  }
  const apply = (layout: LayoutState): void => {
    if (stopped) return
    mainPanes = layout.panes
    mainWidths = layout.paneWidths
    const state = store.getState()
    const writing = timer !== undefined || inFlight > 0
    state.setLayout(writing ? { ...layout, panes: state.paneTabIds, paneWidths: state.paneWidths } : layout)
  }

  api.getLayout().then(apply, (err: unknown) => console.warn('[layout] read failed:', err))
  const off = api.onLayoutChanged(apply)
  const unsubscribe = store.subscribe((state, before) => {
    if (state.paneTabIds === before.paneTabIds && state.paneWidths === before.paneWidths) return
    clearTimeout(timer)
    timer = differs() ? setTimeout(flush, debounceMs) : undefined
  })

  return () => {
    stopped = true
    clearTimeout(timer)
    unsubscribe()
    off()
  }
}
