import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LAYOUT_FILE, LayoutStore, loadLayout, normalizeWidths } from '@main/store/layoutStore'
import { DEFAULT_LAYOUT, type LayoutState } from '@shared/types'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qclod-layout-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeLayout(value: unknown): void {
  writeFileSync(join(dir, LAYOUT_FILE), JSON.stringify(value), 'utf8')
}

function stored(): LayoutState {
  return JSON.parse(readFileSync(join(dir, LAYOUT_FILE), 'utf8')) as LayoutState
}

describe('loadLayout', () => {
  test('нет файла или он не JSON — раскладка по умолчанию', () => {
    expect(loadLayout(dir)).toEqual(DEFAULT_LAYOUT)
    writeFileSync(join(dir, LAYOUT_FILE), '{ не json', 'utf8')
    expect(loadLayout(dir)).toEqual(DEFAULT_LAYOUT)
    writeLayout([1, 2])
    expect(loadLayout(dir)).toEqual(DEFAULT_LAYOUT)
  })

  test('мусор в layout.json даёт раскладку по умолчанию по полю', () => {
    writeLayout({ panes: 5, projects: [{ cwd: 1 }], sidebarCollapsed: 'yes', active: 7, paneWidths: 'x' })
    expect(loadLayout(dir)).toEqual(DEFAULT_LAYOUT)

    // A good field survives next to a bad one.
    writeLayout({
      panes: ['a', 'b'],
      active: 'b',
      paneWidths: [0.25, 0.75],
      sidebarCollapsed: true,
      projects: [{ cwd: 'C:\\A', collapsed: true }, { cwd: 1 }, { cwd: 'C:\\B', collapsed: 'да' }]
    })
    expect(loadLayout(dir)).toEqual({
      panes: ['a', 'b'],
      active: 'b',
      paneWidths: [0.25, 0.75],
      sidebarCollapsed: true,
      projects: [
        { cwd: 'C:\\A', collapsed: true },
        { cwd: 'C:\\B', collapsed: false }
      ]
    })
  })

  test('ширины выравниваются под число панелей', () => {
    writeLayout({ panes: ['a', 'b'], paneWidths: [0.2, 0.3, 0.5] })
    expect(loadLayout(dir).paneWidths).toEqual([0.5, 0.5])
  })

  test('одна папка в разной записи — один проект', () => {
    writeLayout({ projects: [{ cwd: 'C:\\A', collapsed: false }, { cwd: 'c:/a/', collapsed: true }] })
    expect(loadLayout(dir).projects).toEqual([{ cwd: 'C:\\A', collapsed: false }])
  })
})

describe('normalizeWidths', () => {
  test('normalizeWidths', () => {
    expect(normalizeWidths([0.5, 0.5], 3)).toEqual([1 / 3, 1 / 3, 1 / 3])
    expect(normalizeWidths([2, 2], 2)).toEqual([0.5, 0.5])
    expect(normalizeWidths([0, 1], 2)).toEqual([0.05, 0.95])
  })

  test('ноль панелей — пусто, одна — вся ширина, мусор — поровну', () => {
    expect(normalizeWidths([0.3, 0.7], 0)).toEqual([])
    expect(normalizeWidths([0.3], 1)).toEqual([1])
    expect(normalizeWidths([NaN, 1], 2)).toEqual([0.5, 0.5])
    expect(normalizeWidths([0, 0], 2)).toEqual([0.5, 0.5])
  })

  test('каждая не уже 0.05, сумма 1', () => {
    const widths = normalizeWidths([0.001, 0.001, 10, 0.002], 4)
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(0.05)
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
  })
})

describe('LayoutStore', () => {
  test('addProject не дублирует одну папку в разной записи', () => {
    const seen: LayoutState[] = []
    const layout = new LayoutStore(dir, (l) => seen.push(l))
    layout.addProject('C:\\A')
    layout.addProject('c:/a/')
    expect(layout.get().projects).toEqual([{ cwd: 'C:\\A', collapsed: false }])
    expect(stored().projects).toEqual([{ cwd: 'C:\\A', collapsed: false }])
    // The second call changed nothing, so nobody was told.
    expect(seen).toHaveLength(1)
  })

  test('addProject с hostId — другой проект, hostId записан', () => {
    const layout = new LayoutStore(dir, () => undefined)
    layout.addProject('/home/u/p')
    layout.addProject('/home/u/p', 'srv1')
    layout.addProject('/home/u/p', 'srv1')
    expect(layout.get().projects).toEqual([
      { cwd: '/home/u/p', collapsed: false },
      { cwd: '/home/u/p', collapsed: false, hostId: 'srv1' }
    ])
  })

  test('forgetProject с открытым чатом — false и ничего не меняет', () => {
    const seen: LayoutState[] = []
    const layout = new LayoutStore(dir, (l) => seen.push(l))
    layout.addProject('C:\\A')
    layout.addProject('C:\\B')
    const before = layout.get()
    seen.length = 0

    expect(layout.forgetProject('c:/a', ['c:\\a'])).toBe(false)
    expect(layout.get()).toEqual(before)
    expect(stored()).toEqual(before)
    expect(seen).toEqual([])

    expect(layout.forgetProject('c:/a', ['c:\\b'])).toBe(true)
    expect(layout.get().projects).toEqual([{ cwd: 'C:\\B', collapsed: false }])
    expect(stored().projects).toEqual([{ cwd: 'C:\\B', collapsed: false }])
    expect(seen).toHaveLength(1)
  })

  test('forgetProject с hostId убирает только проект той машины', () => {
    const layout = new LayoutStore(dir, () => undefined)
    layout.addProject('/p')
    layout.addProject('/p', 'srv1')
    expect(layout.forgetProject('/p', ['/p'], 'srv1')).toBe(true)
    expect(layout.get().projects).toEqual([{ cwd: '/p', collapsed: false }])
  })

  test('patch: панели, ширины под их число, боковая панель, свёрнутость проекта', () => {
    const seen: LayoutState[] = []
    const layout = new LayoutStore(dir, (l) => seen.push(l))
    layout.addProject('C:\\A')

    expect(layout.patch({ panes: ['a', 'b'] }).paneWidths).toEqual([0.5, 0.5])
    expect(layout.patch({ paneWidths: [1, 3] }).paneWidths).toEqual([0.25, 0.75])
    layout.patch({ sidebarCollapsed: true, projectCollapsed: { cwd: 'c:/a/', collapsed: true } })
    // A folder that is no project is not made one by collapsing it.
    layout.patch({ projectCollapsed: { cwd: 'C:\\чужая', collapsed: true } })

    expect(layout.get()).toEqual({
      panes: ['a', 'b'],
      active: null,
      paneWidths: [0.25, 0.75],
      sidebarCollapsed: true,
      projects: [{ cwd: 'C:\\A', collapsed: true }]
    })
    expect(stored()).toEqual(layout.get())
    expect(seen.at(-1)).toEqual(layout.get())
  })

  test('get отдаёт копию: её правка не трогает раскладку', () => {
    const layout = new LayoutStore(dir, () => undefined)
    layout.patch({ panes: ['a'] })
    const copy = layout.get()
    copy.panes.push('x')
    copy.projects.push({ cwd: 'C:\\X', collapsed: false })
    expect(layout.get().panes).toEqual(['a'])
    expect(layout.get().projects).toEqual([])
  })

  test('setActive пишет активный чат и сообщает', () => {
    const seen: LayoutState[] = []
    const layout = new LayoutStore(dir, (l) => seen.push(l))
    layout.setActive('a')
    layout.setActive('a')
    expect(stored().active).toBe('a')
    expect(seen.map((l) => l.active)).toEqual(['a'])
  })

  test('prune убирает мёртвые панели и выравнивает ширины', () => {
    writeLayout({ panes: ['gone', 'b', 'c'], active: 'gone', paneWidths: [0.2, 0.3, 0.5] })
    const layout = new LayoutStore(dir, () => undefined)
    layout.prune(['b', 'c'])
    const l = layout.get()
    expect(l.panes).toEqual(['b', 'c'])
    expect(l.paneWidths[0]).toBeCloseTo(0.375, 10)
    expect(l.paneWidths[1]).toBeCloseTo(0.625, 10)
    expect(l.active).toBeNull()
    expect(stored().panes).toEqual(['b', 'c'])
  })

  test('новая раскладка читается из того же файла', () => {
    const first = new LayoutStore(dir, () => undefined)
    first.addProject('C:\\A')
    first.patch({ panes: ['a'], sidebarCollapsed: true })
    first.setActive('a')
    expect(new LayoutStore(dir, () => undefined).get()).toEqual(first.get())
  })
})
