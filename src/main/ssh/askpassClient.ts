/**
 * The askpass side ssh runs (stage 6, decision 5): Qclod.exe itself on
 * Windows (QCLOD_ASKPASS_PIPE set, see index.ts), `askpass.js` through a sh
 * wrapper on a Mac. It hands ssh's question to the running Qclod over its pipe
 * and prints the answer for ssh. No Electron and nothing of the app here: this
 * runs in a process that must not become a second Qclod.
 *
 * The wire: one JSON line each way — {token, prompt} in, {ok, value?} out.
 */
import { connect } from 'node:net'

/** ssh waits for the person; the window may take a while, but not forever. */
const CLIENT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_REPLY_BYTES = 64 * 1024

/**
 * `argv` — the askpass arguments only (ssh passes the question as one).
 * Prints the answer and a newline; 0 when there is one, 1 for «no».
 */
export function runAskpassClient(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: (s: string) => void = (s) => void process.stdout.write(s)
): Promise<number> {
  const pipe = env['QCLOD_ASKPASS_PIPE']
  const token = env['QCLOD_ASKPASS_TOKEN']
  const prompt = argv.length > 0 ? argv[argv.length - 1]! : ''
  if (!pipe || !token) return Promise.resolve(1)
  return new Promise<number>((resolve) => {
    let settled = false
    let buffer = ''
    const finish = (code: number, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (code === 0 && value !== undefined) out(value + '\n')
      resolve(code)
    }
    const socket = connect(pipe)
    const timer = setTimeout(() => finish(1), CLIENT_TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(JSON.stringify({ token, prompt }) + '\n')
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_REPLY_BYTES) return finish(1)
      const end = buffer.indexOf('\n')
      if (end < 0) return
      let reply: unknown
      try {
        reply = JSON.parse(buffer.slice(0, end))
      } catch {
        return finish(1)
      }
      const r = reply as { ok?: unknown; value?: unknown }
      if (r && r.ok === true && typeof r.value === 'string' && !/[\r\n]/.test(r.value)) finish(0, r.value)
      else finish(1)
    })
    socket.on('error', () => finish(1))
    socket.on('close', () => finish(1))
  })
}
