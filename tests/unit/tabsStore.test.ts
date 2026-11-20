import { describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

describe('tabsStore: идентификатор последней сессии', () => {
  test('lastSessionId сохраняется и читается', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-tabs-session-'))
    try {
      saveTabs(dir, [
        {
          id: 'a',
          cwd: dir,
          title: 'A',
          overrides: {},
          lastSessionId: '11111111-1111-1111-1111-111111111111'
        }
      ])

      expect(loadTabs(dir)[0]!.lastSessionId).toBe('11111111-1111-1111-1111-111111111111')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('нестроковый lastSessionId отбрасывается', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-tabs-session-'))
    try {
      writeFileSync(
        join(dir, TABS_FILE),
        JSON.stringify([{ id: 'a', cwd: dir, title: 'A', overrides: {}, lastSessionId: 42 }]),
        'utf8'
      )

      expect(loadTabs(dir)[0]!.lastSessionId).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tabsStore: усилие', () => {
  test('усилие вкладки сохраняется в tabs.json и читается, чужие значения — нет', () => {
    const dir = freshDir()
    saveTabs(dir, [tab({ overrides: { model: 'opus', effort: 'high' } })])
    expect(loadTabs(dir)[0]!.overrides).toEqual({ model: 'opus', effort: 'high' })

    writeFileSync(
      join(dir, TABS_FILE),
      JSON.stringify([{ id: 't1', cwd: tmpdir(), title: 'x', overrides: { effort: 'ultra' } }]),
      'utf8'
    )
    expect(loadTabs(dir)[0]!.overrides).toEqual({})
    rmSync(dir, { recursive: true, force: true })
  })

  test('bypassPermissions не попадает в tabs.json', () => {
    const dir = freshDir()
    saveTabs(dir, [tab({ overrides: { permissionMode: 'bypassPermissions', model: 'm' } })])
    expect(loadTabs(dir)[0]!.overrides).toEqual({ model: 'm' })
    expect(readFileSync(join(dir, TABS_FILE), 'utf8')).not.toContain('bypassPermissions')
    rmSync(dir, { recursive: true, force: true })
  })

  test('bypassPermissions из старого tabs.json при чтении отбрасывается', () => {
    const dir = freshDir()
    writeFileSync(
      join(dir, TABS_FILE),
      JSON.stringify([{ id: 't', cwd: tmpdir(), title: 't', overrides: { permissionMode: 'bypassPermissions' } }]),
      'utf8'
    )
    expect(loadTabs(dir)[0]!.overrides).toEqual({})
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('tabsStore: автономность', () => {
  test('autonomy сохраняется и читается', () => {
    const dir = freshDir()
    try {
      saveTabs(dir, [
        tab({ id: 'a', autonomy: { working: true, remote: true, limitUntil: 1_800_000_000_000 } }),
        tab({ id: 'b', autonomy: { remote: true } }),
        tab({ id: 'c' })
      ])
      const [a, b, c] = loadTabs(dir)
      expect(a!.autonomy).toEqual({ working: true, remote: true, limitUntil: 1_800_000_000_000 })
      expect(b!.autonomy).toEqual({ remote: true })
      expect(c!.autonomy).toBeUndefined()
      // An empty record is no record: nothing is written for it.
      saveTabs(dir, [tab({ id: 'd', autonomy: {} })])
      const raw = JSON.parse(readFileSync(join(dir, TABS_FILE), 'utf8')) as Array<Record<string, unknown>>
      expect(raw[0]).not.toHaveProperty('autonomy')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('мусор в autonomy (working: "да", limitUntil: -1) отбрасывается, вкладка остаётся', () => {
    const dir = freshDir()
    try {
      const entries = [
        { id: 'a', cwd: dir, title: 'A', overrides: {}, autonomy: { working: 'да', limitUntil: -1 } },
        { id: 'b', cwd: dir, title: 'B', overrides: {}, autonomy: { working: false, remote: 1, limitUntil: 'x' } },
        { id: 'c', cwd: dir, title: 'C', overrides: {}, autonomy: 'всё' },
        { id: 'd', cwd: dir, title: 'D', overrides: {}, autonomy: { working: true, limitUntil: 'INF' } }
      ]
      // JSON has no Infinity, but 1e400 parses to it.
      writeFileSync(join(dir, TABS_FILE), JSON.stringify(entries).replace('"INF"', '1e400'), 'utf8')
      const tabs = loadTabs(dir)
      expect(tabs.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
      expect(tabs[0]!.autonomy).toBeUndefined()
      expect(tabs[1]!.autonomy).toBeUndefined()
      expect(tabs[2]!.autonomy).toBeUndefined()
      expect(tabs[3]!.autonomy).toEqual({ working: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
