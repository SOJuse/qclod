import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinPlatform } from './platform'

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
  buildEditorArgv,
  buildEditorCommand,
  editorSpawnPosix,
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

  // Excel opens a .csv the agent wrote without Protected View, formulas and all.
  test.each(['data.csv', 'data.TSV'])('%s — только показывается', (n) =>
    expect(isRunnable(`C:\\p\\${n}`)).toBe(true)
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

// fileActions is Windows-only by construction: drive-letter long names, explorer.exe, cmd.exe.
// The real-disk and real-cmd.exe groups below run only there; the pure string tests run anywhere.
const onWindows = process.platform === 'win32'

describe.skipIf(!onWindows)('openPath / revealPath', () => {
  test('openPath для .exe показывает в проводнике, не запускает', async () => {
    const p = file('setup.exe')
    expect(await openPath(p)).toBe('revealed')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).toHaveBeenCalledWith(p)
  })

  test.each([
    'x.py', 'run.sh', 'srv.rdp', 'disk.iso', 'q.search-ms', 'macro.docm', 'page.html', 'a.js', 'pic.svg',
    'r.rtf', 'w.doc', 'w.docx', 't.dotx', 's.xls', 's.xlsx', 's.xlsm', 'p.ppt', 'p.pptx', 'o.odt', 'o.ods', 'o.odp'
  ])(
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

  // A folder never goes through shell.openPath: swapped for a file between
  // the check and the call, it would be launched by its association.
  test('папка открывается явным explorer.exe, а не shell.openPath', async () => {
    const d = join(DIR, 'src folder')
    mkdirSync(d, { recursive: true })
    expect(await openPath(d)).toBe('opened')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawn.mock.calls[0]!
    expect(cmd).toBe('explorer.exe')
    expect(args).toEqual([`"${d}"`])
    expect(opts).toMatchObject({ windowsVerbatimArguments: true, detached: true })
  })

  test('папка с «исполняемым» именем (folder.exe) только показывается', async () => {
    const d = join(DIR, 'folder.exe')
    mkdirSync(d, { recursive: true })
    expect(await openPath(d)).toBe('revealed')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).toHaveBeenCalledWith(d)
  })

  test('папка с безопасным расширением (notes.md) тоже открывается через explorer.exe', async () => {
    const d = join(DIR, 'notes-dir.md')
    mkdirSync(d, { recursive: true })
    expect(await openPath(d)).toBe('opened')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(spawn.mock.calls[0]![0]).toBe('explorer.exe')
  })

  test('файла нет — длинное имя не узнать, показывается в проводнике', async () => {
    expect(await openPath(join(DIR, 'нет.md'))).toBe('revealed')
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  // An 8.3 name (PAYLOA~1.TXT) hides the real extension (.txtzz): the check
  // must look at the long name Windows will actually open.
  const shortName = (() => {
    if (!onWindows) return null
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

  test('обратный слеш перед кавычкой рядом с плейсхолдером — отказ', () => {
    // The editor would read \" as a literal quote, and the quoting would flip.
    for (const template of ['ed --file=\\"{path}"', 'ed --file="{path}\\"', 'ed --a="{line}\\":{path}']) {
      expect(() => buildEditorCommand(template, { path: 'C:\\a.ts' }), template).toThrow(/безопасно/)
    }
  })

  test('непарная кавычка в шаблоне — отказ', () => {
    expect(() => buildEditorCommand('ed "{path}', { path: 'C:\\a.ts' })).toThrow(/кавычк/)
  })
})

/**
 * The editor here is node printing its argv, started through the very cmd.exe
 * line openInEditor would run. What it prints is what an editor would get.
 */
describe.skipIf(!onWindows)('строка редактора через настоящий cmd.exe', () => {
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

  // `^"` is a literal quote to cmd, so it flips what looks quoted: with it
  // `^"x" {path}` put the path's `&` outside quotes and ran `echo INJ`.
  test.each(['^"x" "{path}"', '^"x" {path}', 'a^&b {path}'])(
    'шаблон %s с ^ вне кавычек не запускается',
    (template) => {
      const path = 'C:\\a&echo INJ&b.ts'
      expect(() => run(template, { path })).toThrow(/\^/)
      expect(openInEditor(`${editor} ${template}`, { path })).toMatch(/\^/)
      expect(spawn).not.toHaveBeenCalled()
    }
  )

  test('^ внутри кавычек шаблона — обычный символ', () => {
    const path = 'C:\\a&echo INJ&b.ts'
    expect(run('"a^b" {path}', { path })).toBe(JSON.stringify(['a^b', path]))
  })

  test('скобки в пути внутри --file="{path}" доходят как есть', () => {
    const path = 'C:\\Program Files (x86)\\Ed\\x.ts'
    expect(run('--file="{path}"', { path })).toBe(JSON.stringify([`--file=${path}`]))
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

// macOS: the same promises as the Windows groups above, through shell.openPath / open / direct spawn.
describe('macOS: buildEditorArgv / editorSpawnPosix', () => {
  const target = { path: '/Users/me/my proj/a b.ts', line: 3, column: 5 }

  test('слова, кавычки и подстановка без оболочки', () => {
    expect(buildEditorArgv('code -g "{path}":{line}:{column}', target)).toEqual([
      'code', '-g', '/Users/me/my proj/a b.ts:3:5'
    ])
    expect(buildEditorArgv("zed '{path}:{line}'", target)).toEqual(['zed', '/Users/me/my proj/a b.ts:3'])
  })

  test('символы оболочки в пути остаются обычным текстом', () => {
    const evil = { path: '/tmp/a&echo INJECTED;$(x)`y`|z.ts' }
    expect(buildEditorArgv('ed {path}', evil)).toEqual(['ed', evil.path])
  })

  test('непарная кавычка — сообщение пользователю', () => {
    expect(() => buildEditorArgv('code "{path}', target)).toThrow(/кавычк/)
  })

  test('.app идёт через open -a, остальное — напрямую', () => {
    expect(editorSpawnPosix(['Visual Studio Code.app', '/x.ts'])).toEqual({
      cmd: 'open',
      args: ['-a', 'Visual Studio Code.app', '/x.ts']
    })
    expect(editorSpawnPosix(['code', '-g', '/x.ts:1'])).toEqual({ cmd: 'code', args: ['-g', '/x.ts:1'] })
    expect(editorSpawnPosix([])).toBeNull()
  })
})

describe('macOS: openInEditor', () => {
  pinPlatform('darwin', { beforeEach, afterEach })

  test('запускает редактор напрямую, без cmd.exe, отвязанно', () => {
    expect(openInEditor('code -g {path}:{line}', { path: '/Users/me/a b.ts', line: 3 })).toBeNull()
    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawn.mock.calls[0]!
    expect(cmd).toBe('code')
    expect(args).toEqual(['-g', '/Users/me/a b.ts:3'])
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    expect((opts as { env: Record<string, string> }).env['PATH']).toContain('/opt/homebrew/bin')
  })

  test('приложение .app — через open -a', () => {
    openInEditor('"Sublime Text.app" {path}', { path: '/Users/me/a.ts' })
    const [cmd, args] = spawn.mock.calls[0]!
    expect(cmd).toBe('open')
    expect(args).toEqual(['-a', 'Sublime Text.app', '/Users/me/a.ts'])
  })

  test('пустой шаблон и непарная кавычка ничего не запускают', () => {
    expect(openInEditor('  ', { path: '/a.ts' })).toBeNull()
    expect(openInEditor('code "{path}', { path: '/a.ts' })).toMatch(/кавычк/)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('revealPath показывает в Finder', () => {
    revealPath('/Users/me/a.md')
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/Users/me/a.md')
  })
})

describe.skipIf(onWindows)('macOS: openPath на настоящем диске', () => {
  pinPlatform('darwin', { beforeEach, afterEach })

  test.each(['setup.exe', 'run.sh', 'x.command', 'a.py', 'page.html', 'w.docx', 'noext'])(
    '%s — только показывается в Finder',
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
  })

  test('ссылка notes.md на скрипт судится по цели', async () => {
    const target = file('real.sh')
    const link = join(DIR, 'notes-link.md')
    symlinkSync(target, link)
    expect(await openPath(link)).toBe('revealed')
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  test('папка открывается, а папка Thing.app — только показывается', async () => {
    const d = join(DIR, 'plain dir')
    mkdirSync(d, { recursive: true })
    expect(await openPath(d)).toBe('opened')
    expect(shell.openPath).toHaveBeenCalledWith(d)
    shell.openPath.mockClear()
    const app = join(DIR, 'Thing.app')
    mkdirSync(app, { recursive: true })
    expect(await openPath(app)).toBe('revealed')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).toHaveBeenCalledWith(app)
  })

  test('файла нет — показывается', async () => {
    expect(await openPath(join(DIR, 'нет.md'))).toBe('revealed')
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  test('нет программы для файла — показывается в Finder', async () => {
    const p = file('b.txt')
    shell.openPath.mockImplementation(async () => 'no app')
    expect(await openPath(p)).toBe('revealed')
    expect(shell.showItemInFolder).toHaveBeenCalledWith(p)
  })
})
