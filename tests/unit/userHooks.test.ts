import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectHooks, readUserHooks } from '@main/store/userHooks'

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-home-'))
  mkdirSync(join(dir, '.claude'), { recursive: true })
  return dir
}

function writeUserSettings(dir: string, contents: string): void {
  writeFileSync(join(dir, '.claude', 'settings.json'), contents, 'utf8')
}

describe('readUserHooks', () => {
  test('нет файла — undefined, без исключения', () => {
    expect(readUserHooks(home())).toBeUndefined()
  })

  test('повреждённый JSON — undefined, без исключения', () => {
    const dir = home()
    writeUserSettings(dir, '{ broken')
    expect(() => readUserHooks(dir)).not.toThrow()
    expect(readUserHooks(dir)).toBeUndefined()
  })

  test('секция hooks читается как есть', () => {
    const dir = home()
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }
    writeUserSettings(dir, JSON.stringify({ hooks, model: 'opus' }))
    expect(readUserHooks(dir)).toEqual(hooks)
  })

  test('файл без секции hooks — undefined', () => {
    const dir = home()
    writeUserSettings(dir, JSON.stringify({ model: 'opus' }))
    expect(readUserHooks(dir)).toBeUndefined()
  })

  test('чтение не изменяет файл пользователя', () => {
    const dir = home()
    const original = JSON.stringify({ hooks: { Stop: [] }, model: 'opus' })
    writeUserSettings(dir, original)
    readUserHooks(dir)
    const after = readFileSyncUtf8(join(dir, '.claude', 'settings.json'))
    expect(after).toBe(original)
  })
})

function readFileSyncUtf8(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:fs').readFileSync(path, 'utf8')
}

describe('collectHooks', () => {
  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-proj-'))
    mkdirSync(join(dir, '.claude'), { recursive: true })
    return dir
  }

  function writeProjectSettings(dir: string, name: string, contents: string): void {
    writeFileSync(join(dir, '.claude', name), contents, 'utf8')
  }

  test('хуки проекта читаются вместе с пользовательскими', () => {
    // Spec 6.9: silently disabling someone else's hooks is unacceptable, and a
    // repo's own hooks are someone else's hooks too.
    const home = homeDir()
    writeUserSettings(home, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user' }] }] } }))

    const cwd = project()
    writeProjectSettings(
      cwd,
      'settings.json',
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'project' }] }] } })
    )

    const merged = collectHooks(cwd, home) as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    const commands = merged['Stop'].flatMap((entry) => entry.hooks.map((h) => h.command))
    expect(commands).toContain('user')
    expect(commands).toContain('project')
  })

  test('локальные настройки проекта тоже учитываются', () => {
    const cwd = project()
    writeProjectSettings(
      cwd,
      'settings.local.json',
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'local' }] }] } })
    )
    const merged = collectHooks(cwd, homeDir()) as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    expect(merged['Stop'][0].hooks[0].command).toBe('local')
  })

  test('события из разных файлов не затирают друг друга', () => {
    const home = homeDir()
    writeUserSettings(home, JSON.stringify({ hooks: { Stop: [{ hooks: [] }] } }))
    const cwd = project()
    writeProjectSettings(cwd, 'settings.json', JSON.stringify({ hooks: { PreToolUse: [{ hooks: [] }] } }))

    const merged = collectHooks(cwd, home) as Record<string, unknown>
    expect(Object.keys(merged).sort()).toEqual(['PreToolUse', 'Stop'])
  })

  test('нет ни одного файла — undefined', () => {
    expect(collectHooks(project(), homeDir())).toBeUndefined()
  })

  test('повреждённый файл проекта не ломает сбор', () => {
    const cwd = project()
    writeProjectSettings(cwd, 'settings.json', '{ сломано')
    expect(() => collectHooks(cwd, homeDir())).not.toThrow()
  })
})

function homeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-home-'))
  mkdirSync(join(dir, '.claude'), { recursive: true })
  return dir
}
