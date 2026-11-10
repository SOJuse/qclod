import { exec, execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const runShell = promisify(exec)

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
    const options = { timeout: 20000, windowsHide: true }
    // The shell is needed on Windows only; building the line ourselves (the
    // command is a constant of ours) avoids passing args to a shell.
    if (process.platform === 'win32') await runShell(`${command} --version`, options)
    else await run(command, ['--version'], options)
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
export async function detectInstallMethods(): Promise<InstallMethod[]> {
  const methods: InstallMethod[] = []
  if (process.platform === 'win32' && (await canRun('winget'))) methods.push('winget')
  if (await canRun('npm')) methods.push('npm')
  return methods
}

/** The best way to install, or null; what the environment report shows. */
export async function detectInstallMethod(): Promise<InstallMethod | null> {
  return (await detectInstallMethods())[0] ?? null
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
  return runInstaller(plan.command, plan.args, onOutput, onDone)
}

/**
 * Tries each method in turn: the next one only when the previous failed and
 * nobody cancelled. `onDone` fires once, with the last method's result.
 */
export function installWithFallback(
  methods: InstallMethod[],
  onOutput: (line: string) => void,
  onDone: (ok: boolean) => void,
  start: typeof installAgent = installAgent
): InstallHandle {
  if (methods.length === 0) {
    onOutput('Нечем установить: нет ни winget, ни Node.js.')
    onDone(false)
    return { cancel: () => undefined }
  }
  let cancelled = false
  let current: InstallHandle | null = null
  const attempt = (index: number): void => {
    const method = methods[index]
    current = start(method, onOutput, (ok) => {
      const next = methods[index + 1]
      if (ok || cancelled || next === undefined) {
        onDone(ok)
        return
      }
      onOutput(`${method} не справился — пробую через ${next}.`)
      attempt(index + 1)
    })
  }
  attempt(0)
  return {
    cancel: () => {
      cancelled = true
      current?.cancel()
    }
  }
}

/**
 * One argument for a cmd.exe command line. Quoted when it holds anything cmd
 * treats specially; `%` is expanded by cmd even inside quotes, so it is
 * closed out of the quotes and caret-escaped. Backslashes right before any
 * quote this adds — the closing one, a doubled `"`, the pair around a `%` —
 * are doubled, or the program would read `\"` as a literal quote
 * (`C:\%PATH%` would arrive as `C:"%PATH%`).
 */
/**
 * cmd.exe's arguments for one command line built with `quoteArg`. Quoted
 * whole, as Node does for `shell: true`: with /s cmd strips exactly that
 * outer pair and runs the line as written. /d skips AutoRun, and /v:off keeps
 * `!` literal even where the registry turns delayed expansion on.
 */
export function cmdShellArgs(line: string): string[] {
  return ['/d', '/v:off', '/s', '/c', `"${line}"`]
}

export function quoteArg(arg: string): string {
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg
  const body = arg
    .replace(/(\\+)$/, '$1$1')
    .replace(/(\\*)"/g, '$1$1""')
    .replace(/(\\*)%/g, '$1$1"^%"')
  return `"${body}"`
}

/**
 * With `shell: true` the child is cmd.exe; `child.kill()` ends only it while
 * winget/npm keep running. taskkill /T takes the whole tree.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', () => child.kill())
      killer.on('exit', (code) => {
        if (code !== 0) child.kill()
      })
      return
    } catch {
      /* fall through to a plain kill */
    }
  }
  child.kill()
}

/**
 * Runs an installer command and streams its output. `onDone` fires exactly
 * once — a failed spawn can raise both `error` and `close`.
 */
export function runInstaller(
  command: string,
  args: string[],
  onOutput: (line: string) => void,
  onDone: (ok: boolean) => void
): InstallHandle {
  let finished = false
  const finish = (ok: boolean): void => {
    if (finished) return
    finished = true
    onDone(ok)
  }

  let child: ChildProcess
  try {
    // Both winget (a Store alias) and npm (a .cmd) need the shell to resolve.
    // The line is built here, so no args array is handed to a shell (DEP0190).
    child =
      process.platform === 'win32'
        ? spawn('cmd.exe', cmdShellArgs([command, ...args.map(quoteArg)].join(' ')), {
            windowsHide: true,
            windowsVerbatimArguments: true
          })
        : spawn(command, args, { windowsHide: true })
  } catch (error) {
    onOutput(error instanceof Error ? error.message : String(error))
    finish(false)
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
    finish(false)
  })

  child.on('close', (code) => {
    onOutput(code === 0 ? 'Готово.' : `Установщик вышел с кодом ${code}.`)
    finish(code === 0)
  })

  return {
    cancel: () => {
      if (finished) return
      onOutput('Отменено.')
      killTree(child)
    }
  }
}

export class InstallSlot {
  private running = false
  private handle: InstallHandle | null = null
  private cancelRequested = false

  get busy(): boolean {
    return this.running
  }

  /**
   * Takes the slot synchronously; null if an install is already running. The
   * slot frees only when `done` is called — i.e. when the process is really
   * gone — never on cancel.
   */
  start(
    begin: (done: (ok: boolean) => void) => InstallHandle | Promise<InstallHandle>
  ): Promise<boolean> | null {
    if (this.running) return null
    this.running = true
    this.cancelRequested = false
    return new Promise<boolean>((resolve) => {
      let finished = false
      const done = (ok: boolean): void => {
        if (finished) return
        finished = true
        this.handle = null
        this.running = false
        resolve(ok)
      }
      const attach = (handle: InstallHandle): void => {
        if (finished) return
        this.handle = handle
        if (this.cancelRequested) handle.cancel()
      }
      try {
        Promise.resolve(begin(done)).then(attach, () => done(false))
      } catch {
        done(false)
      }
    })
  }

  cancel(): void {
    if (!this.running) return
    this.cancelRequested = true
    this.handle?.cancel()
  }
}
