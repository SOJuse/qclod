import type { RelayReader } from '../ssh/remoteFiles'
import { RelayCallError } from '../ssh/relayClient'
import { GitMissingError, type GitRun, type GitRunner } from './gitRunner'

/** Why the Git button of a server chat is off (stage 7, task 15). */
export const REMOTE_GIT_TEXT = {
  offline: 'Сервер не на связи',
  oldRelay: 'Обновите посредник Qclod в настройках «Серверы»'
} as const

/** git cannot be asked at all right now: GitService shows `unavailable` with this reason. */
export class GitUnavailableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'GitUnavailableError'
  }
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
/** The relay's own answer comes on top of git's run. */
const CALL_SLACK_MS = 15_000

/**
 * The GitRunner of a server project: the relay's git.run, over the one ssh
 * channel the chat already has (no ssh per call). `git` and GIT_BASE_ARGS are
 * the relay's to add; the args go as they are, never through a shell.
 */
export function remoteGitRunner(client: () => Promise<RelayReader>, cwd: string): GitRunner {
  return async (args, opts = {}) => {
    let relay: RelayReader
    try {
      relay = await client()
    } catch {
      throw new GitUnavailableError(REMOTE_GIT_TEXT.offline)
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const params = {
      cwd,
      args,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      timeoutMs,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      ...(opts.readOnly ? { readOnly: true } : {})
    }
    let out: GitRun
    try {
      out = await relay.call<GitRun>('git.run', params, { timeoutMs: timeoutMs + CALL_SLACK_MS })
    } catch (err) {
      if (err instanceof RelayCallError) {
        if (err.code === 'unsupported') throw new GitUnavailableError(REMOTE_GIT_TEXT.oldRelay)
        if (err.code === 'offline') throw new GitUnavailableError(REMOTE_GIT_TEXT.offline)
        if (err.code === 'not_found') throw new Error('Папки нет на сервере.')
      }
      throw err
    }
    if (out.code === 127 && /git not found/.test(out.stderr)) throw new GitMissingError()
    return out
  }
}
