import { fallbackTextFor } from '../shared/fallbackReason'

// The page of a window that will not start. No React and nothing from the
// renderer bundle: if that bundle is what fails, this still has to work. The
// preload is the same one, so the three ways out are its methods.
const actions: Array<[string, () => Promise<void>]> = [
  ['fallback-retry', () => window.qclod.retryRenderer()],
  ['fallback-logs', () => window.qclod.openLogs()],
  ['fallback-close', () => window.qclod.closeWindow()]
]

for (const [id, run] of actions) {
  document.querySelector(`[data-testid="${id}"]`)?.addEventListener('click', () => {
    run().catch((err: unknown) => console.warn('[fallback]', id, err))
  })
}

// What happened is told by main in the address (shared/fallbackReason.ts); the
// page itself carries the neutral wording until then and when it is not told.
const text = document.querySelector('.fb-text')
if (text) text.textContent = fallbackTextFor(location.search)
