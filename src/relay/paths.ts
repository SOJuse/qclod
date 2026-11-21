import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

/** Where the relay keeps everything: ~/.qclod and nothing outside it. */
export interface RelayPaths {
  root: string
  /** The binary itself: bin/qclod-relay. */
  bin: string
  /** Socket and lock, 0700. */
  run: string
  socket: string
  lock: string
  state: string
  /** One folder per session, with its journal. */
  sessions: string
  /** Files sent from Qclod, per session. */
  uploads: string
  logs: string
}

export const BINARY_NAME = 'qclod-relay'

/**
 * The relay's paths under `home`. `override` — QCLOD_RELAY_HOME of a test build
 * of the relay. On win32 (tests only: the relay ships for Linux) the socket is
 * a named pipe, one per root.
 */
export function relayPaths(home: string, platform: NodeJS.Platform = process.platform, override?: string): RelayPaths {
  const path = platform === 'win32' ? win32 : posix
  const root = override ?? path.join(home, '.qclod')
  const run = path.join(root, 'run')
  const socket =
    platform === 'win32'
      ? `\\\\.\\pipe\\qclod-relay-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`
      : path.join(run, 'relay.sock')
  return {
    root,
    bin: path.join(root, 'bin'),
    run,
    socket,
    lock: path.join(run, 'relay.lock'),
    state: path.join(root, 'state.json'),
    sessions: path.join(root, 'sessions'),
    uploads: path.join(root, 'uploads'),
    logs: path.join(root, 'logs')
  }
}
