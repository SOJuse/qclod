import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  editorShellArgs,
  isRunnable,
  openInEditor,
  openPath,
  revealPath
} from '@main/files/fileActions'

type Log = Array<{ action: string; path: string; line?: number }>
const g = globalThis as { __qclodShellLog?: Log }

/** Real files, so the long-name check sees what Windows sees. */
const DIR = realpathSync.native(mkdtempSync(join(tmpdir(), 'qclod-actions-')))
function file(name: string): string {
  const p = join(DIR, name)
  writeFileSync(p, '')
  return p
}

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

  test.each(['a.ts', 'план.md', 'photo.png'])('%s — не исполняемое', (n) =>
    expect(isRunnable(`C:\\p\\${n}`)).toBe(false)
  )

  test('неизвестный тип и файл без расширения считаются исполняемыми', () => {
    expect(isRunnable('C:\\p\\a.xyz')).toBe(true)
    expect(isRunnable('C:\\p\\README')).toBe(true)
  })

  test('точки и пробелы на конце Windows отбрасывает — setup.exe. всё ещё исполняемое', () => {
    expect(isRunnable('C:\\p\\setup.exe.')).toBe(true)
    expect(isRunnable('C:\\p\\setup.exe ')).toBe(true)
  })
})

describe('openPath / revealPath', () => {
  test('openPath для .exe показывает в проводнике, не запускает', async () => {
    const p = file('setup.exe')
    expect(await openPath(p)).toBe('revealed')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).toHaveBeenCalledWith(p)
  })

  test.each(['x.py', 'run.sh', 'srv.rdp', 'disk.iso', 'q.search-ms', 'macro.docm', 'page.html', 'a.js', 'pic.svg'])(
    '%s — не в белом списке, показывается в проводнике',
    async (n) => {
      const p = file(n)
      expect(await openPath(p)).toBe('revealed')
      expect(shell.openPath).not.toHaveBeenCalled()
      expect(shell.showItemInFolder).toHaveBeenCalledWith(p)
    }
  )

  test.each(['a.ts', 'notes.md', 'pic.png', 'doc.pdf'])('%s — открывается программой по умолчанию', async (n) => {
    const p = file(n)
    expect(await openPath(p)).toBe('opened')
    expect(shell.openPath).toHaveBeenCalledWith(p)
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  test('папка открывается в проводнике', async () => {
    const d = join(DIR, 'folder.exe')
    mkdirSync(d, { recursive: true })
    expect(await openPath(d)).toBe('opened')
    expect(shell.openPath).toHaveBeenCalledWith(d)
  })

  test('файла нет — длинное имя не узнать, показывается в проводнике', async () => {
    expect(await openPath(join(DIR, 'нет.md'))).toBe('revealed')
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  // An 8.3 name (PAYLOA~1.TXT) hides the real extension (.txtzz): the check
  // must look at the long name Windows will actually open.
  const shortName = (() => {
    const long = file('payload-longname.txtzz')
    const out = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], {
      windowsVerbatimArguments: true,
      encoding: 'utf8'
    }).stdout.trim()
    return out !== long && /~\d/.test(out) ? out : null
  })()
  test.skipIf(shortName === null)('короткое имя 8.3 проверяется по длинному', async () => {
    expect(shortName!.toUpperCase().endsWith('.TXT')).toBe(true)
    expect(await openPath(shortName!)).toBe('revealed')
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  test('нет программы для файла — показывается в проводнике', async () => {
    const p = file('b.txt')
    shell.openPath.mockImplementation(async () => 'нет сопоставленной программы')
    expect(await openPath(p)).toBe('revealed')
    expect(shell.showItemInFolder).toHaveBeenCalledWith(p)
  })

  test('revealPath показывает в проводнике', () => {
    revealPath('C:\\p\\a.md')
    expect(shell.showItemInFolder).toHaveBeenCalledWith('C:\\p\\a.md')
  })

  test('с QCLOD_FAKE_SHELL действия пишутся в журнал, shell не трогается', async () => {
    process.env['QCLOD_FAKE_SHELL'] = '1'
    const md = file('c.md')
    const exe = file('c.exe')
    expect(await openPath(md)).toBe('opened')
    expect(await openPath(exe)).toBe('revealed')
    revealPath(DIR)
    expect(openInEditor('code -g {path}:{line}', { path: md, line: 3 })).toBeNull()
    expect(g.__qclodShellLog).toEqual([
      { action: 'open', path: md },
      { action: 'reveal', path: exe },
      { action: 'reveal', path: DIR },
      { action: 'editor', path: md, line: 3 }
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

  test('% после обратного слеша: слеши перед вынесенным % удваиваются', () => {
    expect(buildEditorCommand('ed {path}', { path: 'C:\\%PATH%\\x.ts' })).toBe(
      'ed "C:\\\\"^%"PATH"^%"\\x.ts"'
    )
  })

  test('плейсхолдер внутри чужих кавычек с опасным путём — отказ', () => {
    expect(() =>
      buildEditorCommand('ed --file="{path}"', { path: 'C:\\a&echo INJECTED2&b.ts' })
    ).toThrow(/кавычк/)
  })

  test('непарная кавычка в шаблоне — отказ', () => {
    expect(() => buildEditorCommand('ed "{path}', { path: 'C:\\a.ts' })).toThrow(/кавычк/)
  })
})

/**
 * The editor here is node printing its argv, started through the very cmd.exe
 * line openInEditor would run. What it prints is what an editor would get.
 */
describe('строка редактора через настоящий cmd.exe', () => {
  const script = join(DIR, 'argv.js')
  writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const editor = `"${process.execPath}" "${script}"`

  function run(template: string, target: { path: string; line?: number }): string {
    const line = buildEditorCommand(`${editor} ${template}`, target)
    const res = spawnSync('cmd.exe', editorShellArgs(line), {
      windowsVerbatimArguments: true,
      encoding: 'utf8'
    })
    return res.stdout.trim()
  }

  test('& в пути не выполняет команду', () => {
    const path = 'C:\\a&echo INJECTED2&b.ts'
    expect(run('{path}:{line}', { path, line: 3 })).toBe(JSON.stringify([`${path}:3`]))
  })

  test('плейсхолдер в кавычках вместе с ключом: «"-x {path}"» — один аргумент, без инъекции', () => {
    const path = 'C:\\a&echo INJECTED2&b.ts'
    expect(run('"-x {path}"', { path })).toBe(JSON.stringify([`-x ${path}`]))
  })

  test('безопасный путь с пробелом внутри --file="{path}"', () => {
    expect(run('--file="{path}"', { path: 'C:\\a b\\x.ts' })).toBe(
      JSON.stringify(['--file=C:\\a b\\x.ts'])
    )
  })

  test('% после слеша доходит без искажений', () => {
    const path = 'C:\\%PATH%\\x.ts'
    expect(run('{path}', { path })).toBe(JSON.stringify([path]))
  })

  test('! ^ ( ) в пути доходят как есть', () => {
    const path = 'C:\\a!b^c(1)\\x %USERNAME% y.ts'
    expect(run('{path}', { path })).toBe(JSON.stringify([path]))
  })
})

describe('openInEditor', () => {
  test('запускает cmd.exe с готовой строкой, отвязанно и без окна', () => {
    expect(openInEditor('code -g {path}:{line}', { path: 'C:\\a b\\x.ts', line: 3 })).toBeNull()
    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawn.mock.calls[0]!
    expect(cmd).toBe('cmd.exe')
    expect(args).toEqual(['/d', '/v:off', '/s', '/c', '"code -g "C:\\a b\\x.ts:3""'])
    expect(opts).toMatchObject({ detached: true, windowsHide: true, windowsVerbatimArguments: true })
  })

  test('опасная подстановка в кавычки шаблона не запускается, а объясняет', () => {
    const error = openInEditor('ed --file="{path}"', { path: 'C:\\a&echo INJECTED2&b.ts' })
    expect(error).toMatch(/кавычк/)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('пустой шаблон — ничего не запускается', () => {
    expect(openInEditor('   ', { path: 'C:\\a\\x.ts' })).toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })
})
