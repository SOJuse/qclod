import { describe, expect, test } from 'vitest'
import {
  DRAG_CHAT,
  DRAG_SESSION,
  dropOnPane,
  dropWhere,
  equalWidths,
  readDrop,
  resizePanes
} from '../../src/renderer/app/paneOps'

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

describe('dropOnPane (Review Focus 5)', () => {
  test('чат из панелей переезжает, а не дублируется', () => {
    expect(dropOnPane(['a', 'b', 'c'], 'a', 2, 'after')).toEqual(['b', 'c', 'a'])
    expect(dropOnPane(['a', 'b', 'c'], 'c', 0, 'before')).toEqual(['c', 'a', 'b'])
    expect(dropOnPane(['a', 'b', 'c'], 'a', 2, 'before')).toEqual(['b', 'a', 'c'])
  })

  test('replace уже стоящего чата меняет местами', () => {
    expect(dropOnPane(['a', 'b'], 'a', 1, 'replace')).toEqual(['b', 'a'])
    expect(dropOnPane(['a', 'b', 'c', 'd'], 'd', 0, 'replace')).toEqual(['d', 'b', 'c', 'a'])
  })

  test('на себя — ничего', () => {
    expect(dropOnPane(['a', 'b'], 'b', 1, 'replace')).toEqual(['a', 'b'])
    expect(dropOnPane(['a', 'b'], 'b', 1, 'before')).toEqual(['a', 'b'])
    expect(dropOnPane(['a', 'b'], 'b', 1, 'after')).toEqual(['a', 'b'])
    // Beside its own neighbour, on the side it already stands on.
    expect(dropOnPane(['a', 'b'], 'a', 1, 'before')).toEqual(['a', 'b'])
  })

  test('пятой панели нет', () => {
    const four = ['a', 'b', 'c', 'd']
    expect(dropOnPane(four, 'e', 0, 'before')).toEqual(four)
    expect(dropOnPane(four, 'e', 3, 'after')).toEqual(four)
    expect(dropOnPane(four, 'e', 0, 'replace')).toEqual(['e', 'b', 'c', 'd'])
    // A chat already in the row may still move to an edge: the count stays four.
    expect(dropOnPane(four, 'a', 3, 'after')).toEqual(['b', 'c', 'd', 'a'])
  })

  test('новый чат встаёт слева или справа от цели', () => {
    expect(dropOnPane(['a'], 'b', 0, 'after')).toEqual(['a', 'b'])
    expect(dropOnPane(['a', 'b'], 'c', 1, 'before')).toEqual(['a', 'c', 'b'])
    expect(dropOnPane(['a', 'b'], 'c', 0, 'replace')).toEqual(['c', 'b'])
  })

  test('цель вне ряда — без изменений', () => {
    expect(dropOnPane(['a', 'b'], 'c', 2, 'after')).toEqual(['a', 'b'])
    expect(dropOnPane(['a', 'b'], 'c', -1, 'replace')).toEqual(['a', 'b'])
  })
})

describe('resizePanes', () => {
  test('resizePanes держит минимум', () => {
    const out = resizePanes([0.5, 0.5], 0, -1000, 1000, 320)
    expect(out[0]).toBeCloseTo(0.32, 9)
    expect(out[1]).toBeCloseTo(0.68, 9)
    const other = resizePanes([0.5, 0.5], 0, 1000, 1000, 320)
    expect(other[0]).toBeCloseTo(0.68, 9)
    expect(other[1]).toBeCloseTo(0.32, 9)
  })

  test('сдвиг меняет только две соседние панели', () => {
    const out = resizePanes([0.25, 0.25, 0.25, 0.25], 1, 100, 2000, 320)
    expect(out[0]).toBe(0.25)
    expect(out[1]).toBeCloseTo(0.3, 9)
    expect(out[2]).toBeCloseTo(0.2, 9)
    expect(out[3]).toBe(0.25)
  })

  test('сумма долей — 1', () => {
    let widths = equalWidths(3)
    for (const [splitter, delta] of [
      [0, 137],
      [1, -59],
      [0, -4000]
    ] as const) {
      widths = resizePanes(widths, splitter, delta, 1700, 320)
      expect(Math.abs(sum(widths) - 1)).toBeLessThan(1e-9)
    }
    for (const w of widths) expect(w * 1700).toBeGreaterThanOrEqual(320 - 1e-6)
  })

  test('ряд уже двух минимумов — доли не меняются; неверный разделитель — тоже', () => {
    expect(resizePanes([0.5, 0.5], 0, 50, 500, 320)).toEqual([0.5, 0.5])
    expect(resizePanes([0.5, 0.5], 1, 50, 1000, 320)).toEqual([0.5, 0.5])
    expect(resizePanes([0.5, 0.5], 0, 50, 0, 320)).toEqual([0.5, 0.5])
  })
})

describe('equalWidths, зоны и данные перетаскивания', () => {
  test('equalWidths', () => {
    expect(equalWidths(0)).toEqual([])
    expect(equalWidths(4)).toEqual([0.25, 0.25, 0.25, 0.25])
    expect(Math.abs(sum(equalWidths(3)) - 1)).toBeLessThan(1e-9)
  })

  test('крайние 25 % — before/after, середина — replace', () => {
    expect(dropWhere(0, 400)).toBe('before')
    expect(dropWhere(99, 400)).toBe('before')
    expect(dropWhere(100, 400)).toBe('replace')
    expect(dropWhere(300, 400)).toBe('replace')
    expect(dropWhere(301, 400)).toBe('after')
    expect(dropWhere(399, 400)).toBe('after')
  })

  test('readDrop: чат, прошлая сессия, мусор', () => {
    const from = (data: Record<string, string>) => (type: string) => data[type] ?? ''
    expect(readDrop(from({ [DRAG_CHAT]: 't1' }))).toEqual({ kind: 'chat', tabId: 't1' })
    const session = JSON.stringify({ cwd: 'C:\\p', sessionId: 's1', title: 'T' })
    expect(readDrop(from({ [DRAG_SESSION]: session }))).toEqual({
      kind: 'session',
      cwd: 'C:\\p',
      sessionId: 's1',
      title: 'T'
    })
    expect(readDrop(from({}))).toBeNull()
    expect(readDrop(from({ [DRAG_SESSION]: '{не json' }))).toBeNull()
    expect(readDrop(from({ [DRAG_SESSION]: JSON.stringify({ cwd: 'C:\\p' }) }))).toBeNull()
    expect(readDrop(from({ [DRAG_SESSION]: JSON.stringify({ cwd: 1, sessionId: 's', title: '' }) }))).toBeNull()
  })
})
