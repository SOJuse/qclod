import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTabs, saveTabs, TABS_FILE } from '@main/store/tabsStore'
import type { PersistedTab } from '@shared/types'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'qclod-tabs-'))
}

function tab(patch: Partial<PersistedTab> = {}): PersistedTab {
  return {
    id: 't1',
    cwd: tmpdir(),
    title: 'проект',
    overrides: { model: 'opus' },
    ...patch
  }
}

describe('tabsStore', () => {
  test('сохраняются рабочая папка, заголовок и переопределения запуска', () => {
    const dir = freshDir()
    saveTabs(dir, [tab()])
    const [loaded] = loadTabs(dir)
    expect(loaded.cwd).toBe(tmpdir())
    expect(loaded.title).toBe('проект')
    expect(loaded.overrides).toEqual({ model: 'opus' })
    rmSync(dir, { recursive: true, force: true })
  })

  test('содержимое сессии не сохраняется', () => {
    const dir = freshDir()
    const withExtras = {
      ...tab(),
      status: 'busy',
      badge: true,
      scrollback: 'секретный вывод агента'
    } as unknown as PersistedTab
    saveTabs(dir, [withExtras])

    const raw = readFile(join(dir, TABS_FILE))
    expect(raw).not.toContain('секретный вывод')
    expect(raw).not.toContain('scrollback')
    expect(raw).not.toContain('status')
    expect(raw).not.toContain('badge')
    rmSync(dir, { recursive: true, force: true })
  })

  test('вкладка с исчезнувшей папкой помечается и не роняет загрузку', () => {
    const dir = freshDir()
    saveTabs(dir, [tab({ id: 'gone', cwd: join(tmpdir(), 'qclod-no-such-folder-xyz') })])
    const [loaded] = loadTabs(dir)
    expect(loaded.id).toBe('gone')
    expect(loaded.missingCwd).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('существующая папка не помечается', () => {
    const dir = freshDir()
    saveTabs(dir, [tab()])
    expect(loadTabs(dir)[0].missingCwd).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('повреждённый файл даёт пустой список, а не исключение', () => {
    const dir = freshDir()
    writeFileSync(join(dir, TABS_FILE), 'не json', 'utf8')
    expect(() => loadTabs(dir)).not.toThrow()
    expect(loadTabs(dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  test('отсутствующий файл даёт пустой список', () => {
    expect(loadTabs(freshDir())).toEqual([])
  })

  test('записи без обязательных полей отбрасываются', () => {
    const dir = freshDir()
    writeFileSync(
      join(dir, TABS_FILE),
      JSON.stringify([{ id: 'ok', cwd: tmpdir(), title: 'ok', overrides: {} }, { id: 'bad' }, 42]),
      'utf8'
    )
    const loaded = loadTabs(dir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('ok')
    rmSync(dir, { recursive: true, force: true })
  })
})

function readFile(path: string): string {
  return require('node:fs').readFileSync(path, 'utf8') as string
}
