import { createRoot } from 'react-dom/client'
// Fonts ship inside the build from their packages; nothing is fetched at runtime.
import '@fontsource-variable/inter'
import '@fontsource-variable/inter/wght-italic.css'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/geist-mono/wght-italic.css'
import './styles/longText.css'
import './styles/tokens.css'
import './ui/controls.css'
import { App } from './app/App'
import { ErrorBoundary } from './ui/ErrorBoundary'

const container = document.getElementById('root')
if (!container) throw new Error('root container missing')

/**
 * Errors no boundary sees (event handlers, timers, rejected promises) reach
 * the log too; they do not blank the window, but they are what to look at when
 * something quietly stops working.
 */
function report(message: string, stack?: string): void {
  try {
    window.qclod.reportError({ scope: 'window', message, stack })
  } catch (err) {
    console.warn('[renderer] could not report', err)
  }
}

window.addEventListener('error', (e) => {
  const err: unknown = e.error
  report(err instanceof Error ? err.message : e.message, err instanceof Error ? err.stack : undefined)
})
window.addEventListener('unhandledrejection', (e) => {
  // A reason whose toString throws must not become an error of its own.
  try {
    const reason: unknown = e.reason
    report(
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? reason.stack : undefined
    )
  } catch {
    report('unprintable rejection reason')
  }
})

createRoot(container).render(
  <ErrorBoundary scope="app">
    <App />
  </ErrorBoundary>
)

