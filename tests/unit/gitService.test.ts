import { afterEach, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitService, type GitTab } from '@main/git/GitService'
import { localGitRunner } from '@main/git/gitRunner'

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

const AUTHOR = {
  GIT_AUTHOR_NAME: 'Тест',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Тест',
  GIT_COMMITTER_EMAIL: 't@example.com'
}
const env = { ...process.env, ...AUTHOR }

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-git-'))
  dirs.push(dir)
  return dir
}
function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' })
}
/** A repository with one commit holding `files`. */
function repo(files: Record<string, string> = { 'base.txt': 'base\n' }, commit = true): string {
  const dir = tmp()
  sh(dir, 'init', '-q', '-b', 'main')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  if (commit) {
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-qm', 'first')
  }
  return dir
}
function service(dir: string, e: NodeJS.ProcessEnv = env): { svc: GitService; tab: GitTab } {
  const run = localGitRunner(dir, { env: e })
  return { svc: new GitService(() => run), tab: { id: 't1', cwd: dir } }
}

describe.skipIf(!git)('GitService', () => {
  test("коммит файла «-rf [1] Привет 'x'.txt» и переименования", async () => {
    const weird = "-rf [1] Привет 'x'.txt"
    const dir = repo({ 'old name.txt': 'one\ntwo\nthree\nfour\nfive\n', 'third.txt': 'a\n' })
    writeFileSync(join(dir, weird), 'hello\n')
    renameSync(join(dir, 'old name.txt'), join(dir, 'новое имя.txt'))
    writeFileSync(join(dir, 'third.txt'), 'changed\n')
    sh(dir, 'add', '-N', 'новое имя.txt')
    const { svc, tab } = service(dir)
    const status = await svc.status(tab)
    if (status.kind !== 'ok') throw new Error(JSON.stringify(status))
    const paths = status.changes.map((c) => c.path)
    expect(paths).toContain(weird)
    expect(paths).toContain('новое имя.txt')
    const result = await svc.commit(tab, [weird, 'новое имя.txt'], 'Два файла')
    expect(result.ok).toBe(true)
    const files = sh(dir, '-c', 'core.quotepath=false', 'log', '-1', '--name-status', '--format=').trim()
    expect(files).toContain(weird)
    expect(files).toMatch(/^R\d*\s+old name\.txt\s+новое имя\.txt$/m)
    const after = await svc.status(tab)
    if (after.kind !== 'ok') throw new Error('ok expected')
    expect(after.changes).toEqual([{ path: 'third.txt', kind: 'modified' }])
  })

  test('сообщение доходит без изменений', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    const { svc, tab } = service(dir)
    await svc.status(tab)
    const message = '-m\n\n#123 «кавычки» $HOME'
    expect((await svc.commit(tab, ['a.txt'], message)).ok).toBe(true)
    expect(sh(dir, 'log', '-1', '--format=%B').replace(/\n+$/, '')).toBe(message)
  })

  test('index.lock даёт locked', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    const { svc, tab } = service(dir)
    await svc.status(tab)
    writeFileSync(join(dir, '.git', 'index.lock'), '')
    const result = await svc.commit(tab, ['a.txt'], 'x')
    expect(result).toMatchObject({ ok: false, reason: 'locked' })
  })

  test('путь, закоммиченный между статусом и коммитом, даёт stale', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    const { svc, tab } = service(dir)
    await svc.status(tab)
    sh(dir, 'add', 'a.txt')
    sh(dir, 'commit', '-qm', 'agent did it', '--', 'a.txt')
    const result = await svc.commit(tab, ['a.txt', 'b.txt'], 'x')
    expect(result).toMatchObject({ ok: false, reason: 'stale' })
    // b.txt was not committed on the side.
    expect(sh(dir, 'log', '--format=%s')).not.toContain('x\n')
    expect(sh(dir, 'status', '--porcelain')).toContain('b.txt')
  })

  test('без имени и почты → identity', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    const empty = tmp()
    const bare: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: empty,
      USERPROFILE: empty,
      GIT_CONFIG_GLOBAL: join(empty, 'none'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.useConfigOnly',
      GIT_CONFIG_VALUE_0: 'true'
    }
    for (const k of Object.keys(AUTHOR)) delete bare[k]
    const { svc, tab } = service(dir, bare)
    await svc.status(tab)
    const result = await svc.commit(tab, ['a.txt'], 'x')
    expect(result).toMatchObject({ ok: false, reason: 'identity' })
  })

  test('хук pre-commit с отказом → failed с его выводом', async () => {
    const dir = repo()
    const hook = join(dir, '.git', 'hooks', 'pre-commit')
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
    writeFileSync(hook, '#!/bin/sh\necho "нельзя"\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    const { svc, tab } = service(dir)
    await svc.status(tab)
    const result = await svc.commit(tab, ['a.txt'], 'x')
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    if (!result.ok) expect(result.message).toContain('нельзя')
  })

  test('diff пути не из статуса → error', async () => {
    const dir = repo()
    const { svc, tab } = service(dir)
    await svc.status(tab)
    expect(await svc.diff(tab, 'base.txt')).toEqual({ kind: 'error', message: 'Файл не в списке изменений.' })
    expect(await svc.diff(tab, '../../etc/passwd')).toMatchObject({ kind: 'error' })
  })

  test('diff нового файла и изменённого', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'new.ts'), 'const a = 1\nconst b = 2\n')
    writeFileSync(join(dir, 'base.txt'), 'base\nmore\n')
    const { svc, tab } = service(dir)
    await svc.status(tab)
    const added = await svc.diff(tab, 'new.ts')
    expect(added).toMatchObject({ kind: 'text', added: 2, removed: 0 })
    if (added.kind === 'text') expect(added.hunks[0]?.lines.every((l) => l.startsWith('+'))).toBe(true)
    expect(await svc.diff(tab, 'base.txt')).toMatchObject({ kind: 'text', added: 1, removed: 0 })
  })

  test('репозиторий без коммитов: статус initial, diff добавленного файла', async () => {
    const dir = repo({ 'a.txt': 'x\ny\n' }, false)
    sh(dir, 'add', 'a.txt')
    writeFileSync(join(dir, 'b.txt'), 'z\n')
    const { svc, tab } = service(dir)
    const status = await svc.status(tab)
    expect(status).toMatchObject({ kind: 'ok', initial: true })
    expect(await svc.diff(tab, 'a.txt')).toMatchObject({ kind: 'text', added: 2 })
    expect(await svc.diff(tab, 'b.txt')).toMatchObject({ kind: 'text', added: 1 })
    expect((await svc.commit(tab, ['a.txt'], 'Первый')).ok).toBe(true)
  })

  test('конфликт слияния → conflict', async () => {
    const dir = repo({ 'f.txt': 'base\n' })
    sh(dir, 'checkout', '-qb', 'side')
    writeFileSync(join(dir, 'f.txt'), 'side\n')
    sh(dir, 'commit', '-qam', 'side')
    sh(dir, 'checkout', '-q', 'main')
    writeFileSync(join(dir, 'f.txt'), 'main\n')
    sh(dir, 'commit', '-qam', 'main')
    try {
      sh(dir, 'merge', 'side')
    } catch {
      // the conflict is the point
    }
    writeFileSync(join(dir, 'other.txt'), 'o\n')
    const { svc, tab } = service(dir)
    const status = await svc.status(tab)
    if (status.kind !== 'ok') throw new Error('ok expected')
    expect(status.changes.some((c) => c.kind === 'conflict')).toBe(true)
    expect(await svc.commit(tab, ['other.txt'], 'x')).toMatchObject({ ok: false, reason: 'conflict' })
  })

  test('второй commit во время первого → busy', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    const { svc, tab } = service(dir)
    await svc.status(tab)
    const first = svc.commit(tab, ['a.txt'], 'one')
    const second = await svc.commit(tab, ['a.txt'], 'two')
    expect(second).toMatchObject({ ok: false, reason: 'busy' })
    expect((await first).ok).toBe(true)
  })

  test('пустое сообщение и пустой список отвергаются', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    const { svc, tab } = service(dir)
    await svc.status(tab)
    expect(await svc.commit(tab, ['a.txt'], '  \n')).toMatchObject({ ok: false, message: 'Пустое сообщение коммита.' })
    expect(await svc.commit(tab, [], 'x')).toMatchObject({ ok: false })
  })

  test('не репозиторий → notRepo', async () => {
    const dir = tmp()
    const { svc, tab } = service(dir, { ...env, GIT_CEILING_DIRECTORIES: tmpdir() })
    expect(await svc.status(tab)).toEqual({ kind: 'notRepo' })
  })

  test('runner недоступен → unavailable', async () => {
    const svc = new GitService(() => ({ unavailable: 'нет посредника' }))
    expect(await svc.status({ id: 'x', cwd: '.' })).toEqual({ kind: 'unavailable', reason: 'нет посредника' })
  })
})
