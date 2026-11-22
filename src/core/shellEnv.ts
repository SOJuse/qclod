import { execFile } from 'node:child_process'

/** Marks around the printed PATH, so whatever the shell's rc files say before or after is ignored. */
export const PATH_MARK = '__QCLOD_PATH__'

export type RunShell = (
  shell: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; code: number | null }>

const runShell: RunShell = (shell, args, { timeoutMs, env }) =>
  new Promise((resolve, reject) => {
    execFile(shell, args, { timeout: timeoutMs, env, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error && typeof error.code !== 'number') {
        reject(error)
        return
      }
      resolve({ stdout: String(stdout), code: error ? (error.code as number) : 0 })
    })
  })

/**
 * The PATH of the person's login shell. An app started from Finder or the Dock
 * gets launchd's bare PATH, without `~/.local/bin` where Claude Code lives; the
 * shell's rc files are the only place that says what the person's PATH is.
 * `$SHELL -ilc 'printf …'` prints it between marks. Null on a failure, a
 * timeout (a slow rc file) or no marks: the caller falls back to the current PATH.
 */
export async function loginShellPath(opts: {
  shell?: string
  home: string
  run?: RunShell
  timeoutMs?: number
}): Promise<string | null> {
  const shell = opts.shell ?? (process.env['SHELL'] || '/bin/zsh')
  const run = opts.run ?? runShell
  try {
    const { stdout } = await run(shell, ['-ilc', `printf "${PATH_MARK}%s${PATH_MARK}" "$PATH"`], {
      timeoutMs: opts.timeoutMs ?? 3000,
      env: { ...process.env, HOME: opts.home }
    })
    const start = stdout.indexOf(PATH_MARK)
    if (start < 0) return null
    const from = start + PATH_MARK.length
    const end = stdout.indexOf(PATH_MARK, from)
    if (end < 0) return null
    const path = stdout.slice(from, end)
    return path === '' ? null : path
  } catch {
    return null
  }
}

/**
 * The shell's PATH first, then the current one, then the places Claude Code
 * and Homebrew put things; no entry twice.
 */
export function mergePath(current: string, fromShell: string | null, home: string): string {
  const fallbacks = [`${home}/.local/bin`, `${home}/.claude/local`, '/opt/homebrew/bin', '/usr/local/bin']
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of [...(fromShell ?? '').split(':'), ...current.split(':'), ...fallbacks]) {
    if (part === '' || seen.has(part)) continue
    seen.add(part)
    out.push(part)
  }
  return out.join(':')
}
