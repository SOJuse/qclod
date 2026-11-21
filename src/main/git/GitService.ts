import type { CommitResult, GitFileDiff, GitStatus } from '../../shared/types'
import { EMPTY_TREE, parseUnifiedDiff } from './diff'
import { GitMissingError, MIN_GIT, parseGitVersion, type GitRun, type GitRunner } from './gitRunner'
import { MAX_CHANGES, STATUS_ARGS, parseStatusV2 } from './status'

export interface GitTab {
  id: string
  cwd: string
  hostId?: string
}

type Ok = Extract<GitStatus, { kind: 'ok' }>

const MAX_PATHS = MAX_CHANGES
const MAX_MESSAGE = 10_000
const DIFF_MAX_BYTES = 4 * 1024 * 1024
const COMMIT_TIMEOUT_MS = 120_000

/** What the Git layer shows for a commit that did not happen (the texts are the plan's, verbatim). */
const TEXT = {
  identity:
    'Git не знает, от чьего имени коммитить. Задайте имя и почту: git config --global user.name "Имя" и git config --global user.email "почта".',
  nothing: 'Нечего коммитить: отмеченные файлы не изменились.',
  locked: 'Git занят другой командой (файл .git/index.lock). Подождите и попробуйте снова.',
  conflict: 'Есть незавершённое слияние с конфликтами. Разрешите их в терминале или попросите агента.',
  stale: 'Изменения успели поменяться. Список обновлён — проверьте и нажмите ещё раз.',
  busy: 'Коммит уже идёт.',
  empty: 'Пустое сообщение коммита.'
} as const

const fail = (reason: Extract<CommitResult, { ok: false }>['reason'], message: string): CommitResult => ({
  ok: false,
  reason,
  message
})

const tail = (text: string, n: number): string => (text.length > n ? text.slice(text.length - n) : text)

/**
 * Status, diff and commit of the ticked files for one folder per tab. The
 * window never names a folder or a path git has not just reported: paths are
 * taken from the tab's last status only, and travel to git through stdin.
 */
export class GitService {
  private readonly last = new Map<string, Ok>()
  private readonly committing = new Set<string>()
  private readonly versionOk = new WeakMap<GitRunner, string | null>()

  constructor(private readonly runnerFor: (tab: GitTab) => GitRunner | { unavailable: string }) {}

  private runner(tab: GitTab): GitRunner | { unavailable: string } {
    return this.runnerFor(tab)
  }

  /** Once per runner: is this git new enough? null means yes, otherwise the reason. */
  private async versionProblem(run: GitRunner): Promise<string | null> {
    if (this.versionOk.has(run)) return this.versionOk.get(run) ?? null
    const out = await run(['--version'], { readOnly: true })
    const v = parseGitVersion(out.stdout)
    const old = v !== null && (v[0] < MIN_GIT[0] || (v[0] === MIN_GIT[0] && v[1] < MIN_GIT[1]))
    const problem = old ? 'Нужен Git 2.25 или новее.' : null
    this.versionOk.set(run, problem)
    return problem
  }

  async status(tab: GitTab): Promise<GitStatus> {
    const run = this.runner(tab)
    if (typeof run !== 'function') return { kind: 'unavailable', reason: run.unavailable }
    let out: GitRun
    try {
      const problem = await this.versionProblem(run)
      if (problem) return { kind: 'unavailable', reason: problem }
      out = await run(STATUS_ARGS, { readOnly: true })
    } catch (err) {
      if (err instanceof GitMissingError) return { kind: 'noGit' }
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
    if (out.code !== 0) {
      this.last.delete(tab.id)
      if (out.code === 128 && /not a git repository/i.test(out.stderr)) return { kind: 'notRepo' }
      return { kind: 'error', message: tail(out.stderr.trim() || `git вернул код ${out.code}`, 500) }
    }
    // Output cut by the byte limit may end in half a record: drop it.
    const text = out.truncated ? out.stdout.slice(0, out.stdout.lastIndexOf('\0') + 1) : out.stdout
    const parsed = parseStatusV2(text)
    const status: Ok = { kind: 'ok', ...parsed, truncated: parsed.truncated || out.truncated }
    this.last.set(tab.id, status)
    return status
  }

  async diff(tab: GitTab, path: string): Promise<GitFileDiff> {
    const known = this.last.get(tab.id)
    const change = known?.changes.find((c) => c.path === path || c.oldPath === path)
    if (!known || !change) return { kind: 'error', message: 'Файл не в списке изменений.' }
    const run = this.runner(tab)
    if (typeof run !== 'function') return { kind: 'error', message: run.unavailable }
    const base = known.initial ? EMPTY_TREE : 'HEAD'
    const common = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3']
    const args =
      change.kind === 'untracked'
        ? [...common, '--no-index', '--', '/dev/null', change.path]
        : change.kind === 'renamed' && change.oldPath !== undefined
          ? [...common, '-M', base, '--', change.oldPath, change.path]
          : [...common, base, '--', change.path]
    let out: GitRun
    try {
      out = await run(args, { readOnly: true, maxBytes: DIFF_MAX_BYTES })
    } catch (err) {
      if (err instanceof GitMissingError) return { kind: 'error', message: 'Git не найден.' }
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
    if (out.truncated) return { kind: 'tooLarge', bytes: DIFF_MAX_BYTES }
    // --no-index exits 1 when the files differ: that is the normal case.
    const okCode = out.code === 0 || (change.kind === 'untracked' && out.code === 1)
    if (!okCode) return { kind: 'error', message: tail(out.stderr.trim() || `git вернул код ${out.code}`, 500) }
    return parseUnifiedDiff(out.stdout)
  }

  async commit(tab: GitTab, paths: string[], message: string): Promise<CommitResult> {
    if (this.committing.has(tab.id)) return fail('busy', TEXT.busy)
    this.committing.add(tab.id)
    try {
      return await this.doCommit(tab, paths, message)
    } finally {
      this.committing.delete(tab.id)
    }
  }

  /** The ticked paths plus the old name of every rename among them; null if one is not in `status`. */
  private expand(status: Ok, paths: string[]): string[] | null {
    const all = new Set<string>()
    for (const p of paths) {
      const change = status.changes.find((c) => c.path === p)
      if (!change) return null
      all.add(change.path)
      if (change.oldPath !== undefined) all.add(change.oldPath)
    }
    return [...all]
  }

  private async doCommit(tab: GitTab, paths: string[], message: string): Promise<CommitResult> {
    const text = message.trim()
    if (text === '' || message.length > MAX_MESSAGE) return fail('failed', TEXT.empty)
    if (paths.length < 1 || paths.length > MAX_PATHS) return fail('failed', 'Отметьте файлы для коммита.')
    const run = this.runner(tab)
    if (typeof run !== 'function') return fail('failed', run.unavailable)

    const known = this.last.get(tab.id)
    if (!known || this.expand(known, paths) === null) return fail('stale', TEXT.stale)

    const fresh = await this.status(tab)
    if (fresh.kind !== 'ok') {
      return fail('failed', fresh.kind === 'error' ? fresh.message : 'Не удалось прочитать состояние Git.')
    }
    if (fresh.changes.some((c) => c.kind === 'conflict')) return fail('conflict', TEXT.conflict)
    const targets = this.expand(fresh, paths)
    if (targets === null) return fail('stale', TEXT.stale)

    const input = targets.join('\0') + '\0'
    const spec = ['--pathspec-from-file=-', '--pathspec-file-nul']
    try {
      const added = await run(['add', '-A', ...spec], { input })
      if (added.code !== 0) return this.commitFailure(added)
      const done = await run(['commit', '-m', message, ...spec], { input, timeoutMs: COMMIT_TIMEOUT_MS })
      if (done.code !== 0) return this.commitFailure(done)
      const hash = (await run(['rev-parse', '--short', 'HEAD'], { readOnly: true })).stdout.trim()
      const summary = (await run(['log', '-1', '--format=%s'], { readOnly: true })).stdout.trim()
      return { ok: true, hash, summary }
    } catch (err) {
      if (err instanceof GitMissingError) return fail('failed', 'Git не найден.')
      return fail('failed', err instanceof Error ? err.message : String(err))
    }
  }

  private commitFailure(out: GitRun): CommitResult {
    // «nothing to commit» is printed on stdout, the rest on stderr.
    const all = `${out.stderr}\n${out.stdout}`
    if (/Please tell me who you are|unable to auto-detect email/.test(all)) return fail('identity', TEXT.identity)
    if (/index\.lock/.test(all)) return fail('locked', TEXT.locked)
    if (/nothing (added )?to commit|no changes added to commit/.test(all)) return fail('nothing', TEXT.nothing)
    return fail('failed', tail(`${out.stderr}${out.stdout}`.trim(), 2_000))
  }
}
