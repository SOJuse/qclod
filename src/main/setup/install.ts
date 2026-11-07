import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The official Windows package. Verified against the live winget source. */
export const WINGET_ID = 'Anthropic.ClaudeCode'

/** The npm package, for machines without winget but with Node. */
export const NPM_PACKAGE = '@anthropic-ai/claude-code'

export type InstallMethod = 'winget' | 'npm'

export interface InstallHandle {
  cancel: () => void
}

/**
 * Can this command be run at all?
 *
 * Asked by running it, not by looking for its file. `winget` on Windows is a
 * Store app execution alias: the path on PATH cannot even be `stat`ed by a
 * process without package identity — it answers EACCES — yet spawning it
 * works perfectly. Probing the filesystem would conclude Windows has no
 * winget, which is wrong on every Windows 11 machine.
 */
async function canRun(command: string): Promise<boolean> {
  try {
    await run(command, ['--version'], {
      timeout: 20000,
      windowsHide: true,
      shell: process.platform === 'win32'
    })
    return true
  } catch {
    return false
  }
}

/**
 * How this machine can get Claude Code, best option first.
 *
 * winget comes with Windows and needs nothing else — no Node, no npm, no
 * developer setup — which is the whole point: someone handed this app should
 * be able to run it and work, not go shopping for prerequisites first.
 */
export async function detectInstallMethod(): Promise<InstallMethod | null> {
  if (process.platform === 'win32' && (await canRun('winget'))) return 'winget'
  if (await canRun('npm')) return 'npm'
  return null
}

function commandFor(method: InstallMethod): { command: string; args: string[]; label: string } {
  if (method === 'winget') {
    return {
      command: 'winget',
      args: [
        'install',
        '--id',
        WINGET_ID,
        '-e',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity'
      ],
      label: `winget install --id ${WINGET_ID}`
    }
  }
  return {
    command: 'npm',
    args: ['install', '-g', NPM_PACKAGE],
    label: `npm install -g ${NPM_PACKAGE}`
  }
}

/**
 * Installs Claude Code and reports what the installer says as it says it.
 *
 * Qclod does not bundle the agent: it is a program the user logs into and
 * keeps up to date, and a second copy inside an Electron app would mean two
 * versions and two logins. Fetching it on demand is the honest middle: one
 * button, no shopping list.
 */
export function installAgent(
  method: InstallMethod,
  onOutput: (line: string) => void,
  onDone: (ok: boolean) => void
): InstallHandle {
  const plan = commandFor(method)
  onOutput(plan.label)

  let child: ChildProcess
  try {
    child = spawn(plan.command, plan.args, {
      windowsHide: true,
      // Both winget (a Store alias) and npm (a .cmd) need the shell to resolve.
      shell: process.platform === 'win32'
    })
  } catch (error) {
    onOutput(error instanceof Error ? error.message : String(error))
    onDone(false)
    return { cancel: () => undefined }
  }

  const forward = (chunk: Buffer): void => {
    // winget draws progress with carriage returns; one line per repaint would
    // bury the few lines that mean something.
    for (const line of chunk.toString('utf8').split(/\r?\n|\r/)) {
      const text = line.trim()
      if (text !== '' && !/^[\s▒█▓░■\-\\|/]+$/.test(text)) onOutput(text)
    }
  }

  child.stdout?.on('data', forward)
  child.stderr?.on('data', forward)

  child.on('error', (error) => {
    onOutput(error.message)
    onDone(false)
  })

  child.on('close', (code) => {
    onOutput(code === 0 ? 'Готово.' : `Установщик вышел с кодом ${code}.`)
    onDone(code === 0)
  })

  return {
    cancel: () => {
      child.kill()
    }
  }
}
