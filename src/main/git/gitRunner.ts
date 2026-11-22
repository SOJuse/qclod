import { execFile as nodeExecFile } from 'node:child_process'

/**
 * Every git call goes through here: argv only (no shell), and the folder's own
 * config neutralised. An agent may have cloned a repository whose .git/config
 * names a fsmonitor, a pager, an external diff or a credential helper; opening
 * the panel must run none of them.
 */
export const GIT_BASE_ARGS = [
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.quotepath=false',
  '-c',
  'color.ui=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'diff.external=',
  '-c',
  'credential.helper='
]

/** The oldest git whose porcelain v2 and --pathspec-from-file we rely on. */
export const MIN_GIT = [2, 25] as const

export interface GitRun {
  code: number
  stdout: string
  stderr: string
  /** The output went over `maxBytes`; stdout is what arrived before that. */
  truncated: boolean
}

export interface GitRunOptions {
  /** Written to stdin, which is then closed. */
  input?: string
  timeoutMs?: number
  maxBytes?: number
  /** A read: git takes no optional locks, so it never fights an agent's own git for the index. */
  readOnly?: boolean
}

export type GitRunner = (args: string[], opts?: GitRunOptions) => Promise<GitRun>

export class GitMissingError extends Error {
  constructor() {
    super('git is not installed')
    this.name = 'GitMissingError'
  }
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

export function localGitRunner(
  cwd: string,
  deps: { execFile?: typeof nodeExecFile; env?: NodeJS.ProcessEnv } = {}
): GitRunner {
  const exec = deps.execFile ?? nodeExecFile
  return (args, opts = {}) =>
    new Promise<GitRun>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...(deps.env ?? process.env),
        GIT_TERMINAL_PROMPT: '0',
        LANGUAGE: 'C',
        ...(opts.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {})
      }
      const child = exec(
        'git',
        [...GIT_BASE_ARGS, ...args],
        {
          cwd,
          env,
          windowsHide: true,
          encoding: 'utf8',
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: opts.maxBytes ?? DEFAULT_MAX_BYTES
        },
        (error, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : String(stdout ?? '')
          const err = typeof stderr === 'string' ? stderr : String(stderr ?? '')
          if (!error) {
            resolve({ code: 0, stdout: out, stderr: err, truncated: false })
            return
          }
          const e = error as NodeJS.ErrnoException & { killed?: boolean }
          if (e.code === 'ENOENT') {
            reject(new GitMissingError())
            return
          }
          if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            resolve({ code: 0, stdout: out, stderr: err, truncated: true })
            return
          }
          if (typeof e.code === 'number') {
            resolve({ code: e.code, stdout: out, stderr: err, truncated: false })
            return
          }
          // Killed by the timeout, or could not start for another reason.
          resolve({ code: -1, stdout: out, stderr: err || e.message, truncated: false })
        }
      )
      if (opts.input !== undefined && child.stdin) {
        child.stdin.on('error', () => {})
        child.stdin.end(opts.input)
      }
    })
}

/** «git version 2.47.1.windows.1» → [2, 47]. */
export function parseGitVersion(text: string): [number, number] | null {
  const m = /git version (\d+)\.(\d+)/.exec(text)
  if (!m) return null
  return [Number(m[1]), Number(m[2])]
}
