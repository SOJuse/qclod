import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * claude's environment on the server: the relay's own plus the login shell's
 * PATH, worked out once when the daemon starts.
 *
 * Решение исполнителя (H1): the same contract as stage 6a's `src/core/shellEnv.ts`
 * (task 4: loginShellPath, mergePath), written here because 6a is not in this
 * branch yet. When the lanes are merged this file re-exports that one.
 */
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

/** $SHELL -ilc 'printf …' between marks; null on a failure, a timeout or no marks. */
export async function loginShellPath(opts: {
  shell?: string
  home: string
  run?: RunShell
  timeoutMs?: number
}): Promise<string | null> {
  const shell = opts.shell ?? (process.env['SHELL'] || '/bin/sh')
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

/** The shell's PATH first, then the current one, then where Claude Code installs itself; no entry twice. */
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

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The first `claude` on PATH that can be run; null when the server has none (I14: only said, never installed). */
export function findClaude(path: string, home: string): string | null {
  for (const dir of [...path.split(':'), `${home}/.local/bin`, `${home}/.claude/local`]) {
    if (dir === '') continue
    const candidate = join(dir, 'claude')
    if (executable(candidate)) return candidate
  }
  return null
}

/**
 * The environment a process started by the daemon gets: never its tmux or
 * systemd marks — a plain successor of a daemon under tmux is not under tmux
 * (host.info reads TMUX and INVOCATION_ID to say which supervisor it runs under).
 */
export function successorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of ['TMUX', 'TMUX_PANE', 'INVOCATION_ID', 'JOURNAL_STREAM']) delete out[key]
  return out
}

/**
 * The binary's own `version` for welcome — every client's hello asks it. Run
 * again only when the file changed (an update put a new one in), by mtime and
 * size; `fallback` (the running daemon's) while there is no file or no answer.
 */
export function cachedBinaryVersion(
  binary: string,
  fallback: string,
  ask: (binary: string) => Promise<string | null>
): () => Promise<string> {
  let cached: { mtimeMs: number; size: number; version: string } | null = null
  return async () => {
    let info
    try {
      info = statSync(binary)
    } catch {
      return fallback
    }
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.version
    const version = await ask(binary)
    if (version === null) return fallback
    cached = { mtimeMs: info.mtimeMs, size: info.size, version }
    return version
  }
}
