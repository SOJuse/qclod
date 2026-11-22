import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { privateMode } from './journal'

export const LOG_FILE = 'relay.log'
export const LOG_MAX_BYTES = 1024 * 1024
export const LOG_KEEP = 3

export interface RelayLog {
  info(event: string): void
  error(event: string, error?: unknown): void
}

/**
 * logs/relay.log: the relay's life — start, stop, restarts, clients coming and
 * going — and its errors. Never a message's text and never a path of the
 * user's: callers say what happened, not what it was about. 1 MB, three files.
 */
export function createLog(dir: string, now: () => number = Date.now): RelayLog {
  const file = join(dir, LOG_FILE)
  function write(level: string, text: string): void {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        // No log yet.
      }
      if (size > LOG_MAX_BYTES) {
        rmSync(`${file}.${LOG_KEEP - 1}`, { force: true })
        for (let i = LOG_KEEP - 2; i >= 1; i--) {
          try {
            renameSync(`${file}.${i}`, `${file}.${i + 1}`)
          } catch {
            // Not there yet.
          }
        }
        renameSync(file, `${file}.1`)
      }
      appendFileSync(file, `${new Date(now()).toISOString()} ${level} ${text.replace(/\s+/g, ' ')}\n`, { mode: 0o600 })
      privateMode(file, 0o600)
    } catch {
      // A log that cannot be written is no reason to stop the relay.
    }
  }
  return {
    info: (event) => write('info', event),
    error: (event, error) => {
      // Only the error's name and code, never its message: it may carry a path.
      const e = error as { name?: unknown; code?: unknown } | undefined
      const kind = e ? [e.name, e.code].filter((x) => typeof x === 'string').join(' ') : ''
      write('error', kind ? `${event}: ${kind}` : event)
    }
  }
}

/** For tests and for `version`: nothing written. */
export const SILENT_LOG: RelayLog = { info: () => undefined, error: () => undefined }
