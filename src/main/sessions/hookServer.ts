import { createServer, type Server, type Socket } from 'node:net'
import type { HookEvent } from '../../shared/types'

export interface HookServer {
  close: () => Promise<void>
}

const MAX_PAYLOAD = 256 * 1024

/**
 * Listens on a local named pipe for hook events. Anything a Claude Code hook
 * writes lands here through `bin/qclod-hook.js`.
 *
 * Everything arriving on the pipe is treated as untrusted input: a malformed
 * or oversized payload is dropped and the server stays up, because losing the
 * status channel would be worse than losing one event.
 */
export function startHookServer(
  pipePath: string,
  onEvent: (event: HookEvent) => void
): Promise<HookServer> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>()

    const server: Server = createServer((socket) => {
      sockets.add(socket)
      let buffer = ''

      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffer += chunk
        if (buffer.length > MAX_PAYLOAD) {
          buffer = ''
          socket.destroy()
        }
      })
      socket.on('end', () => {
        handlePayload(buffer, onEvent)
        sockets.delete(socket)
      })
      socket.on('error', () => sockets.delete(socket))
    })

    server.on('error', reject)
    server.listen(pipePath, () => {
      resolve({
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.close(() => done())
          })
      })
    })
  })
}

function handlePayload(payload: string, onEvent: (event: HookEvent) => void): void {
  const text = payload.trim()
  if (text === '') return

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return

  const record = parsed as Record<string, unknown>
  if (typeof record['tabId'] !== 'string' || typeof record['hook_event_name'] !== 'string') return

  onEvent({
    tabId: record['tabId'],
    hook_event_name: record['hook_event_name'],
    session_id: asString(record['session_id']),
    cwd: asString(record['cwd']),
    matcher: asString(record['matcher']),
    tool_name: asString(record['tool_name']),
    last_assistant_message: asString(record['last_assistant_message'])
  })
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
