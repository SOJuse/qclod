import { afterEach, describe, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localGitRunner, GitMissingError } from '@main/git/gitRunner'

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
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-git-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

describe('localGitRunner', () => {
  test.skipIf(!git)('status во временном репозитории даёт код 0', async () => {
    const dir = repo()
    const run = await localGitRunner(dir)(['status', '--porcelain=v2'], { readOnly: true })
    expect(run.code).toBe(0)
  })

  test.skipIf(!git)('ненулевой код — не исключение', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-git-'))
    dirs.push(dir)
    const run = await localGitRunner(dir, { env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } })(['status'])
    expect(run.code).not.toBe(0)
    expect(run.stderr).toMatch(/not a git repository/)
  })

  test.skipIf(!git)('status и diff не запускают core.fsmonitor и diff.external', async () => {
    const dir = repo()
    const marks = { fsm: join(dir, 'mark-fsm'), ext: join(dir, 'mark-ext'), txt: join(dir, 'mark-txt') }
    const hook = (name: 'fsm' | 'ext' | 'txt'): string => {
      const script = join(dir, `${name}.js`)
      writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marks[name])}, 'x')\n`)
      return `node ${script.replace(/\\/g, '/')}`
    }
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir })
    appendFileSync(join(dir, '.git', 'config'), `[core]\n\tfsmonitor = ${hook('fsm')}\n[diff]\n\texternal = ${hook('ext')}\n`)
    appendFileSync(join(dir, '.git', 'config'), `[diff "evil"]\n\ttextconv = ${hook('txt')}\n`)
    writeFileSync(join(dir, '.gitattributes'), '*.txt diff=evil\n')
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const clear = (): void => Object.values(marks).forEach((m) => rmSync(m, { force: true }))

    // Control: plain git does run them, so the check below can fail.
    execFileSync('git', ['status'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['diff', 'HEAD'], { cwd: dir, stdio: 'ignore' })
    expect(existsSync(marks.fsm) || existsSync(marks.ext)).toBe(true)
    clear()

    const run = localGitRunner(dir)
    expect((await run(['status', '--porcelain=v2'], { readOnly: true })).code).toBe(0)
    expect(
      (await run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'a.txt'], { readOnly: true })).code
    ).toBe(0)
    for (const mark of Object.values(marks)) expect(existsSync(mark)).toBe(false)
  })

  test('ENOENT → GitMissingError', async () => {
    const execFile = vi.fn((_f: unknown, _a: unknown, _o: unknown, cb: (e: unknown) => void) => {
      cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
      return { stdin: null }
    })
    const run = localGitRunner('.', { execFile: execFile as never })
    await expect(run(['status'])).rejects.toBeInstanceOf(GitMissingError)
  })

  test('аргументы уходят массивом, без shell, с окружением git', async () => {
    const execFile = vi.fn((_f: unknown, _a: unknown, _o: unknown, cb: (e: unknown, o: string, s: string) => void) => {
      cb(null, '', '')
      return { stdin: null }
    })
    await localGitRunner('/x', { execFile: execFile as never, env: {} })(['log', '-m; rm -rf /'], { readOnly: true })
    const [file, args, opts] = execFile.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(file).toBe('git')
    expect(args.at(-1)).toBe('-m; rm -rf /')
    expect(args).toContain('--literal-pathspecs')
    expect(opts['shell']).not.toBe(true)
    expect(opts['env']).toMatchObject({ GIT_TERMINAL_PROMPT: '0', LANGUAGE: 'C', GIT_OPTIONAL_LOCKS: '0' })
  })

  test('переполнение maxBuffer → truncated', async () => {
    const execFile = vi.fn((_f: unknown, _a: unknown, _o: unknown, cb: (e: unknown, o: string, s: string) => void) => {
      cb(Object.assign(new Error('too big'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'part', '')
      return { stdin: null }
    })
    const run = await localGitRunner('/x', { execFile: execFile as never })(['diff'])
    expect(run).toMatchObject({ truncated: true, stdout: 'part' })
  })
})
