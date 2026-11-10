import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const shell = vi.hoisted(() => ({
  openPath: vi.fn(async (_p: string) => ''),
  showItemInFolder: vi.fn((_p: string) => undefined)
}))
vi.mock('electron', () => ({ shell }))

const spawn = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ unref: vi.fn(), on: vi.fn() }))
)
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn
}))

import {
  buildEditorCommand,
  isRunnable,
  openInEditor,
  openPath,
  revealPath
} from '@main/files/fileActions'

type Log = Array<{ action: string; path: string; line?: number }>
const g = globalThis as { __qclodShellLog?: Log }

beforeEach(() => {
  shell.openPath.mockClear()
  shell.openPath.mockImplementation(async () => '')
  shell.showItemInFolder.mockClear()
  spawn.mockClear()
  delete process.env['QCLOD_FAKE_SHELL']
  delete g.__qclodShellLog
})
afterEach(() => {
  delete process.env['QCLOD_FAKE_SHELL']
  delete g.__qclodShellLog
})

describe('isRunnable', () => {
  test.each(['setup.exe', 'deploy.BAT', 'x.ps1', 'link.lnk', 'a.cmd', 'app.appref-ms', 'x.reg'])(
    '%s — исполняемое',
    (n) => expect(isRunnable(`C:\\p\\${n}`)).toBe(true)
  )

  test.each(['a.ts', 'план.md', 'photo.png', 'README'])('%s — не исполняемое', (n) =>
    expect(isRunnable(`C:\\p\\${n}`)).toBe(false)
  )

  test('точки и пробелы на конце Windows отбрасывает — setup.exe. всё ещё исполняемое', () => {
    expect(isRunnable('C:\\p\\setup.exe.')).toBe(true)
    expect(isRunnable('C:\\p\\setup.exe ')).toBe(true)
  })
})

describe('openPath / revealPath', () => {
  test('openPath для .exe показывает в проводнике, не запускает', async () => {
    expect(await openPath('C:\\p\\setup.exe')).toBe('revealed')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).toHaveBeenCalledWith('C:\\p\\setup.exe')
  })

  test('обычный файл открывается программой по умолчанию', async () => {
    expect(await openPath('C:\\p\\a.md')).toBe('opened')
    expect(shell.openPath).toHaveBeenCalledWith('C:\\p\\a.md')
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  test('нет программы для файла — показывается в проводнике', async () => {
    shell.openPath.mockImplementation(async () => 'нет сопоставленной программы')
    expect(await openPath('C:\\p\\a.xyz')).toBe('revealed')
    expect(shell.showItemInFolder).toHaveBeenCalledWith('C:\\p\\a.xyz')
  })

  test('revealPath показывает в проводнике', () => {
    revealPath('C:\\p\\a.md')
    expect(shell.showItemInFolder).toHaveBeenCalledWith('C:\\p\\a.md')
  })

  test('с QCLOD_FAKE_SHELL действия пишутся в журнал, shell не трогается', async () => {
    process.env['QCLOD_FAKE_SHELL'] = '1'
    expect(await openPath('C:\\p\\a.md')).toBe('opened')
    expect(await openPath('C:\\p\\setup.exe')).toBe('revealed')
    revealPath('C:\\p')
    openInEditor('code -g {path}:{line}', { path: 'C:\\p\\a.md', line: 3 })
    expect(g.__qclodShellLog).toEqual([
      { action: 'open', path: 'C:\\p\\a.md' },
      { action: 'reveal', path: 'C:\\p\\setup.exe' },
      { action: 'reveal', path: 'C:\\p' },
      { action: 'editor', path: 'C:\\p\\a.md', line: 3 }
    ])
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('buildEditorCommand', () => {
  test('команда редактора: путь с пробелом и & в кавычках', () => {
    expect(buildEditorCommand('code -g {path}:{line}', { path: 'C:\\a b&c\\x.ts', line: 3 })).toBe(
      'code -g "C:\\a b&c\\x.ts:3"'
    )
  })

  test('нет строки — 1, колонка подставляется', () => {
    expect(buildEditorCommand('code -g {path}:{line}:{column}', { path: 'C:\\a\\x.ts' })).toBe(
      'code -g C:\\a\\x.ts:1:1'
    )
  })

  test('отдельные аргументы и путь программы в кавычках не трогаются', () => {
    expect(
      buildEditorCommand('"C:\\Program Files\\Ed\\ed.exe" --line {line} {path}', {
        path: 'C:\\a b\\x.ts',
        line: 7
      })
    ).toBe('"C:\\Program Files\\Ed\\ed.exe" --line 7 "C:\\a b\\x.ts"')
  })

  test('заключённый пользователем в кавычки {path} не получает двойных кавычек', () => {
    expect(buildEditorCommand('ed "{path}"', { path: 'C:\\a b\\x.ts' })).toBe('ed "C:\\a b\\x.ts"')
  })

  test('% в пути не раскрывается как переменная cmd', () => {
    expect(buildEditorCommand('ed {path}', { path: 'C:\\%PATH%\\x.ts' })).toBe(
      'ed "C:\\"^%"PATH"^%"\\x.ts"'
    )
  })
})

describe('openInEditor', () => {
  test('запускает cmd.exe с готовой строкой, отвязанно и без окна', () => {
    openInEditor('code -g {path}:{line}', { path: 'C:\\a b\\x.ts', line: 3 })
    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawn.mock.calls[0]!
    expect(cmd).toBe('cmd.exe')
    expect(args).toEqual(['/d', '/s', '/c', '"code -g "C:\\a b\\x.ts:3""'])
    expect(opts).toMatchObject({ detached: true, windowsHide: true, windowsVerbatimArguments: true })
  })

  test('пустой шаблон — ничего не запускается', () => {
    openInEditor('   ', { path: 'C:\\a\\x.ts' })
    expect(spawn).not.toHaveBeenCalled()
  })
})
