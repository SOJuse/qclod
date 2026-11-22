import { connect, type Socket } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import type { RelayPaths } from './paths'

export const ATTACH_WAIT_MS = 5000
const RETRY_MS = 100

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(path)
    const fail = (): void => {
      socket.destroy()
      resolve(null)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.off('error', fail)
      resolve(socket)
    })
  })
}

/**
 * `qclod-relay attach`: what Qclod's ssh runs. stdio becomes the daemon's
 * socket, byte for byte — every frame is the daemon's to read. With no daemon
 * it is started once (`startDaemon`), and the socket is tried again for up to
 * five seconds. Resolves with the exit code: 0 when either side ends, 1 when
 * no daemon could be reached.
 */
export async function runAttach(
  paths: RelayPaths,
  io: { stdin: Readable; stdout: Writable },
  startDaemon: () => Promise<void>,
  waitMs = ATTACH_WAIT_MS
): Promise<number> {
  let socket = await tryConnect(paths.socket)
  if (!socket) {
    try {
      await startDaemon()
    } catch {
      // Tried; the socket says whether it came up.
    }
    const until = Date.now() + waitMs
    while (!socket && Date.now() < until) {
      await new Promise((r) => setTimeout(r, RETRY_MS))
      socket = await tryConnect(paths.socket)
    }
  }
  if (!socket) return 1
  const s = socket
  return await new Promise<number>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      io.stdin.unpipe(s)
      s.destroy()
      resolve(0)
    }
    io.stdin.pipe(s)
    s.pipe(io.stdout, { end: false })
    // ssh went away: the client is gone, the daemon carries on.
    io.stdin.once('end', finish)
    io.stdin.once('close', finish)
    s.once('close', finish)
    s.once('error', finish)
  })
}
