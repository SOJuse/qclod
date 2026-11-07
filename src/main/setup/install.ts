import { spawn, type ChildProcess } from 'node:child_process'
import { resolveExecutable } from '../agent/resolveExecutable'

/** The package that provides the `claude` executable. */
export const AGENT_PACKAGE = '@anthropic-ai/claude-code'

export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download'

export interface InstallHandle {
  cancel: () => void
}

/**
 * Installs Claude Code with the user's own npm.
 *
 * Deliberately not bundled into Qclod: the agent is a program the user logs
 * into and keeps up to date, and shipping a second copy inside an Electron app
 * would mean two versions, two logins and an update path nobody asked for.
 * What Qclod can do is run the one command for them and show what it says.
 */
export function installAgent(
  onOutput: (line: string) => void,
  onDone: (ok: boolean) => void
): InstallHandle {
  let npm: string
  try {
    npm = resolveExecutable('npm', process.env)
  } catch {
    onOutput('npm не найден. Сначала поставьте Node.js, затем повторите.')
    onDone(false)
    return { cancel: () => undefined }
  }

  onOutput(`npm install -g ${AGENT_PACKAGE}`)

  let child: ChildProcess
  try {
    child = spawn(npm, ['install', '-g', AGENT_PACKAGE], {
      windowsHide: true,
      // npm on Windows is a .cmd; without a shell the spawn fails outright.
      shell: process.platform === 'win32'
    })
  } catch (error) {
    onOutput(error instanceof Error ? error.message : String(error))
    onDone(false)
    return { cancel: () => undefined }
  }

  const forward = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim() !== '') onOutput(line)
    }
  }

  child.stdout?.on('data', forward)
  child.stderr?.on('data', forward)

  child.on('error', (error) => {
    onOutput(error.message)
    onDone(false)
  })

  child.on('close', (code) => {
    onOutput(code === 0 ? 'Готово.' : `npm вышел с кодом ${code}.`)
    onDone(code === 0)
  })

  return {
    cancel: () => {
      child.kill()
    }
  }
}
