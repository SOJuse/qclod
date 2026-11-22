import { afterEach, describe, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIT_BASE_ARGS } from '@main/git/gitRunner'
import { runGit, type GitRunParams } from '../../src/relay/git'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const git = hasGit()
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-relaygit-'))
  dirs.push(dir)
  return dir
}
const params = (cwd: string, args: string[], extra: Partial<GitRunParams> = {}): GitRunParams => ({
  cwd,
  args,
  timeoutMs: 15_000,
  maxBytes: 1024 * 1024,
  ...extra
})

type Cb = (e: unknown, o: string, s: string) => void
function fakeExec(answer: (cb: Cb) => void) {
  return vi.fn((_f: unknown, _a: unknown, _o: unknown, cb: Cb) => {
    answer(cb)
    return { stdin: { on: vi.fn(), end: vi.fn() } }
  })
}

describe('runGit посредника (этап 7, задача 15)', () => {
  test('GIT_BASE_ARGS перед args, без оболочки, окружение как у localGitRunner', async () => {
    const execFile = fakeExec((cb) => cb(null, 'ok', ''))
    const dir = tmp()
    const run = await runGit(params(dir, ['status', '-rf [1] Привет \'x\'.txt'], { readOnly: true }), {
      execFile: execFile as never,
      env: {}
    })
    expect(run).toEqual({ code: 0, stdout: 'ok', stderr: '', truncated: false })
    const [file, args, opts] = execFile.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(file).toBe('git')
    expect(args).toEqual([...GIT_BASE_ARGS, 'status', '-rf [1] Привет \'x\'.txt'])
    expect(opts['shell']).not.toBe(true)
    expect(opts['cwd']).toBe(dir)
    expect(opts['env']).toEqual({ GIT_TERMINAL_PROMPT: '0', LANGUAGE: 'C', GIT_OPTIONAL_LOCKS: '0' })
  })

  test('input уходит в stdin; без readOnly нет GIT_OPTIONAL_LOCKS', async () => {
    const end = vi.fn()
    const execFile = vi.fn((_f: unknown, _a: unknown, _o: Record<string, unknown>, cb: Cb) => {
      setImmediate(() => cb(null, '', ''))
      return { stdin: { on: vi.fn(), end } }
    })
    await runGit(params(tmp(), ['add', '--pathspec-from-file=-'], { input: 'a.txt\0' }), { execFile: execFile as never, env: {} })
    expect(end).toHaveBeenCalledWith('a.txt\0')
    expect((execFile.mock.calls[0]![2] as { env: Record<string, string> }).env['GIT_OPTIONAL_LOCKS']).toBeUndefined()
  })

  test('нет git — код 127 и «git not found»; ненулевой код и переполнение — как есть', async () => {
    const dir = tmp()
    const missing = fakeExec((cb) => cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), '', ''))
    expect(await runGit(params(dir, ['status']), { execFile: missing as never })).toEqual({
      code: 127,
      stdout: '',
      stderr: 'git not found',
      truncated: false
    })
    const failed = fakeExec((cb) => cb(Object.assign(new Error('x'), { code: 128 }), '', 'fatal: not a git repository'))
    expect(await runGit(params(dir, ['status']), { execFile: failed as never })).toMatchObject({ code: 128, truncated: false })
    const big = fakeExec((cb) => cb(Object.assign(new Error('x'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'part', ''))
    expect(await runGit(params(dir, ['diff']), { execFile: big as never })).toMatchObject({ stdout: 'part', truncated: true })
  })

  test('нет папки — not_found; args не массив строк или длиннее 1000 — bad_request', async () => {
    const execFile = fakeExec((cb) => cb(null, '', ''))
    const deps = { execFile: execFile as never }
    await expect(runGit(params(join(tmp(), 'нет'), ['status']), deps)).rejects.toMatchObject({ code: 'not_found' })
    await expect(runGit({ ...params(tmp(), []), args: 'status' as never }, deps)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(runGit(params(tmp(), [1 as never]), deps)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(runGit(params(tmp(), Array(1001).fill('x')), deps)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(runGit({ ...params(tmp(), ['status']), timeoutMs: -1 }, deps)).rejects.toMatchObject({ code: 'bad_request' })
    expect(execFile).not.toHaveBeenCalled()
  })

  test.skipIf(!git)('настоящий git: злой .git/config с core.fsmonitor и diff.external ничего не запускает', async () => {
    const dir = tmp()
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const marks = { fsm: join(dir, 'mark-fsm'), ext: join(dir, 'mark-ext') }
    const hook = (name: 'fsm' | 'ext'): string => {
      const script = join(dir, `${name}.js`)
      writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marks[name])}, 'x')\n`)
      return `node ${script.replace(/\\/g, '/')}`
    }
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir })
    appendFileSync(join(dir, '.git', 'config'), `[core]\n\tfsmonitor = ${hook('fsm')}\n[diff]\n\texternal = ${hook('ext')}\n`)
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    // Control: plain git does run them, so the check below can fail.
    execFileSync('git', ['status'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['diff', 'HEAD'], { cwd: dir, stdio: 'ignore' })
    expect(existsSync(marks.fsm) || existsSync(marks.ext)).toBe(true)
    for (const m of Object.values(marks)) rmSync(m, { force: true })

    const status = await runGit(params(dir, ['status', '--porcelain=v2', '-z'], { readOnly: true }))
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('a.txt')
    const diff = await runGit(params(dir, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'a.txt'], { readOnly: true }))
    expect(diff.code).toBe(0)
    expect(diff.stdout).toContain('+two')
    for (const mark of Object.values(marks)) expect(existsSync(mark)).toBe(false)
  })
})
