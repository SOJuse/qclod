import { execFile as nodeExecFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { MAX_FRAME_BYTES } from '../shared/relayProtocol'
import { GIT_BASE_ARGS, type GitRun } from '../main/git/gitRunner'
import { RelayError, badRequest } from './errors'

/**
 * git.run on the server (stage 7, task 15): the same call as Qclod's
 * localGitRunner — argv only, no shell, the folder's own config neutralised
 * by GIT_BASE_ARGS (a cloned repository's core.fsmonitor, pager, external diff
 * or credential helper run nothing), no prompts, C locale.
 */
export interface GitRunParams {
  cwd: string
  args: string[]
  input?: string
  timeoutMs: number
  maxBytes: number
  readOnly?: boolean
}

export const GIT_MAX_ARGS = 1000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_BYTES = 8 * 1024 * 1024
const MAX_INPUT = 4 * 1024 * 1024
/** The answer must fit one frame with room to spare: JSON escaping can grow the text. */
const MAX_ANSWER_CHARS = Math.floor(MAX_FRAME_BYTES / 2)

function positiveInt(value: unknown, cap: number, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw badRequest(what)
  return Math.min(value, cap)
}

/** Fits the answer into a frame: an over-long stdout is cut and marked truncated. */
function fitFrame(run: GitRun): GitRun {
  if (JSON.stringify(run.stdout).length + run.stderr.length <= MAX_ANSWER_CHARS) return run
  return { ...run, stdout: run.stdout.slice(0, MAX_ANSWER_CHARS / 4), stderr: run.stderr.slice(0, 64 * 1024), truncated: true }
}

export function runGit(
  p: GitRunParams,
  deps: { execFile?: typeof nodeExecFile; env?: NodeJS.ProcessEnv } = {}
): Promise<GitRun> {
  const raw = p as unknown as Record<string, unknown>
  const { cwd, args, input } = raw
  if (typeof cwd !== 'string' || cwd === '' || cwd.includes('\0')) return Promise.reject(badRequest('cwd'))
  if (!Array.isArray(args) || args.length > GIT_MAX_ARGS || !args.every((a) => typeof a === 'string' && !a.includes('\0'))) {
    return Promise.reject(badRequest('args'))
  }
  if (input !== undefined && (typeof input !== 'string' || input.length > MAX_INPUT)) return Promise.reject(badRequest('input'))
  let timeout: number
  let maxBuffer: number
  try {
    timeout = positiveInt(raw['timeoutMs'], MAX_TIMEOUT_MS, 'timeoutMs')
    maxBuffer = positiveInt(raw['maxBytes'], MAX_BYTES, 'maxBytes')
  } catch (err) {
    return Promise.reject(err)
  }
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) return Promise.reject(new RelayError('not_found', 'папки нет на сервере'))

  const exec = deps.execFile ?? nodeExecFile
  const env: NodeJS.ProcessEnv = {
    ...(deps.env ?? process.env),
    GIT_TERMINAL_PROMPT: '0',
    LANGUAGE: 'C',
    ...(raw['readOnly'] === true ? { GIT_OPTIONAL_LOCKS: '0' } : {})
  }
  return new Promise<GitRun>((resolve) => {
    const child = exec(
      'git',
      [...GIT_BASE_ARGS, ...(args as string[])],
      { cwd, env, windowsHide: true, encoding: 'utf8', timeout, maxBuffer },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '')
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '')
        if (!error) return resolve(fitFrame({ code: 0, stdout: out, stderr: err, truncated: false }))
        const e = error as NodeJS.ErrnoException & { killed?: boolean }
        // No git on the server: Qclod turns this into «Git не найден».
        if (e.code === 'ENOENT') return resolve({ code: 127, stdout: '', stderr: 'git not found', truncated: false })
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return resolve(fitFrame({ code: 0, stdout: out, stderr: err, truncated: true }))
        }
        if (typeof e.code === 'number') return resolve(fitFrame({ code: e.code, stdout: out, stderr: err, truncated: false }))
        // Killed by the timeout, or could not start for another reason.
        resolve(fitFrame({ code: -1, stdout: out, stderr: err || e.message, truncated: false }))
      }
    )
    if (typeof input === 'string' && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}
