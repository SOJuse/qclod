import { spawn, type IPty } from '@lydell/node-pty'
import { resolve } from 'node:path'

export const FAKE_AGENT = resolve(__dirname, '../../fixtures/fake-agent/index.js')

export interface Driver {
  pty: IPty
  output(): string
  write(data: string): void
  waitFor(needle: string | RegExp, timeoutMs?: number): Promise<string>
  exit: Promise<number>
  kill(): void
}

/** Drives a process through a real pty, the same way a Qclod tab will. */
export function drive(file: string, args: string[] = [], cwd = process.cwd()): Driver {
  const pty = spawn(file, args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env: { ...process.env }
  })

  let buffer = ''
  let exitCode: number | undefined
  const waiters: Array<() => void> = []

  pty.onData((d) => {
    buffer += d
    for (const notify of waiters.splice(0)) notify()
  })

  const exit = new Promise<number>((resolveExit) => {
    pty.onExit(({ exitCode: code }) => {
      exitCode = code
      for (const notify of waiters.splice(0)) notify()
      resolveExit(code)
    })
  })

  async function waitFor(needle: string | RegExp, timeoutMs = 8000): Promise<string> {
    const matches = (): boolean =>
      typeof needle === 'string' ? buffer.includes(needle) : needle.test(buffer)
    const deadline = Date.now() + timeoutMs
    while (!matches()) {
      if (exitCode !== undefined && !matches()) {
        throw new Error(
          `process exited (${exitCode}) before "${String(needle)}" appeared.\n--- output ---\n${buffer}`
        )
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`timed out waiting for "${String(needle)}".\n--- output ---\n${buffer}`)
      }
      await new Promise<void>((r) => {
        const timer = setTimeout(r, Math.min(remaining, 50))
        waiters.push(() => {
          clearTimeout(timer)
          r()
        })
      })
    }
    return buffer
  }

  return {
    pty,
    output: () => buffer,
    write: (data) => pty.write(data),
    waitFor,
    exit,
    kill: () => {
      try {
        pty.kill()
      } catch {
        /* already gone */
      }
    }
  }
}

export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}
