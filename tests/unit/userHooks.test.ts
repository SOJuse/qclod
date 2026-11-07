import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readUserHooks } from '@main/store/userHooks'

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
