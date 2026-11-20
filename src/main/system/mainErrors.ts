import type { ErrorEntry } from './errorLog'

/** What to write about a thing that was thrown or rejected; never throws itself. */
function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: value.message, stack: value.stack }
  try {
    return { message: String(value) }
  } catch {
    // An object whose toString throws must not turn one error into two.
    return { message: 'unprintable value' }
  }
}

/**
 * Writes down what the main process throws, from the first line of index.ts on:
 * an error before `app.whenReady()` is the one nobody sees otherwise. Listening
 * to `uncaughtExceptionMonitor` does not change what Node does with the error;
 * `unhandledRejection` it does quiet (Electron only warns), so the rejection is
 * printed here as well.
 */
export function installMainErrorHandlers(
  proc: Pick<NodeJS.Process, 'on'>,
  log: (e: ErrorEntry) => void
): void {
  const write = (value: unknown): void => {
    try {
      log({ source: 'main', ...describe(value), at: Date.now() })
    } catch {
      // The log is the last resort; if it fails there is nowhere else to say so.
    }
  }
  proc.on('uncaughtExceptionMonitor', (err) => write(err))
  proc.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection in main:', reason)
    write(reason)
  })
}
