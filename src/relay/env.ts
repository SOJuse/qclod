import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { loginShellPath as coreLoginShellPath } from '../core/shellEnv'

/**
 * claude's environment on the server: the relay's own plus the login shell's
 * PATH, worked out once when the daemon starts. The contract is stage 6a's
 * (src/core/shellEnv.ts); a server without $SHELL falls back to /bin/sh, not
 * the Mac's /bin/zsh.
 */
export { PATH_MARK, mergePath, type RunShell } from '../core/shellEnv'

export function loginShellPath(opts: Parameters<typeof coreLoginShellPath>[0]): Promise<string | null> {
  return coreLoginShellPath({ ...opts, shell: opts.shell ?? (process.env['SHELL'] || '/bin/sh') })
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
