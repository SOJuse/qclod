import { describe, expect, it, test, vi } from 'vitest'
import { PATH_MARK, loginShellPath, mergePath, type RunShell } from '../../src/core/shellEnv'

const out = (stdout: string) => vi.fn<RunShell>(async () => ({ stdout, code: 0 }))

describe('loginShellPath', () => {
  test('шум из rc до и после меток отбрасывается', async () => {
    const run = out(`Welcome!\nnvm: loaded\n${PATH_MARK}/Users/a/.local/bin:/usr/bin${PATH_MARK}\nbye`)
    await expect(loginShellPath({ shell: '/bin/zsh', home: '/Users/a', run })).resolves.toBe(
      '/Users/a/.local/bin:/usr/bin'
    )
  })

  test('оболочка зовётся как -ilc с printf между метками, таймаут 3000 мс', async () => {
    const run = out(`${PATH_MARK}/usr/bin${PATH_MARK}`)
    await loginShellPath({ shell: '/bin/zsh', home: '/Users/a', run })
    const [shell, args, opts] = run.mock.calls[0]!
    expect(shell).toBe('/bin/zsh')
    expect(args).toEqual(['-ilc', `printf "${PATH_MARK}%s${PATH_MARK}" "$PATH"`])
    expect(opts.timeoutMs).toBe(3000)
    expect(opts.env['HOME']).toBe('/Users/a')
  })

  test('таймаут и ошибка запуска — null', async () => {
    const slow: RunShell = () => Promise.reject(new Error('timed out'))
    await expect(loginShellPath({ shell: '/bin/zsh', home: '/h', run: slow })).resolves.toBeNull()
  })

  test('нет меток или пустой PATH — null', async () => {
    await expect(loginShellPath({ shell: 'z', home: '/h', run: out('просто шум') })).resolves.toBeNull()
    await expect(loginShellPath({ shell: 'z', home: '/h', run: out(PATH_MARK) })).resolves.toBeNull()
    await expect(loginShellPath({ shell: 'z', home: '/h', run: out(`${PATH_MARK}${PATH_MARK}`) })).resolves.toBeNull()
  })

  test('оболочка по умолчанию — $SHELL, иначе /bin/zsh', async () => {
    const saved = process.env['SHELL']
    try {
      process.env['SHELL'] = '/bin/bash'
      let run = out(`${PATH_MARK}/x${PATH_MARK}`)
      await loginShellPath({ home: '/h', run })
      expect(run.mock.calls[0]![0]).toBe('/bin/bash')
      delete process.env['SHELL']
      run = out(`${PATH_MARK}/x${PATH_MARK}`)
      await loginShellPath({ home: '/h', run })
      expect(run.mock.calls[0]![0]).toBe('/bin/zsh')
    } finally {
      if (saved === undefined) delete process.env['SHELL']
      else process.env['SHELL'] = saved
    }
  })

  // The real thing, on a Mac runner (CI `mac`): a real zsh answers with a PATH that has /usr/bin.
  it.runIf(process.platform === 'darwin')('настоящий zsh отдаёт PATH с /usr/bin', async () => {
    const path = await loginShellPath({ shell: '/bin/zsh', home: process.env['HOME'] ?? '/', timeoutMs: 10_000 })
    expect(path).not.toBeNull()
    expect(path!.split(':')).toContain('/usr/bin')
  })
})

describe('mergePath', () => {
  test('сначала оболочка, затем текущий, затем запасные; без повторов', () => {
    expect(mergePath('/usr/bin:/bin', '/Users/a/.local/bin:/usr/bin', '/Users/a')).toBe(
      '/Users/a/.local/bin:/usr/bin:/bin:/Users/a/.claude/local:/opt/homebrew/bin:/usr/local/bin'
    )
  })

  test('оболочка не ответила — текущий и запасные', () => {
    expect(mergePath('/usr/bin', null, '/Users/a')).toBe(
      '/usr/bin:/Users/a/.local/bin:/Users/a/.claude/local:/opt/homebrew/bin:/usr/local/bin'
    )
  })

  test('пустые элементы выбрасываются', () => {
    expect(mergePath('/a::/b', ':/c:', '/h').startsWith('/c:/a:/b:')).toBe(true)
  })
})
