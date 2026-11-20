import { describe, expect, test } from 'vitest'
import {
  DRAG_CHAT,
  DRAG_IN_ROW,
  DRAG_SESSION,
  dropOnPane,
  dropWhere,
  dropZone,
  equalWidths,
  moveSplitter,
  paneMinScale,
  readDrop,
  resizePanes
} from '../../src/renderer/app/paneOps'

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

describe('dropZone: полный ряд (S2-R22а)', () => {
  const chat = [DRAG_CHAT]
  const inRow = [DRAG_CHAT, DRAG_IN_ROW]
  const session = [DRAG_SESSION]

  test('при 4 панелях края чужого чата и прошлой сессии инертны, середина — замена', () => {
    expect(dropZone('before', chat, 4)).toBeNull()
    expect(dropZone('after', chat, 4)).toBeNull()
    expect(dropZone('after', session, 4)).toBeNull()
    expect(dropZone('replace', chat, 4)).toBe('replace')
    expect(dropZone('replace', session, 4)).toBe('replace')
  })

  test('при 4 панелях края подсвечены для чата, уже стоящего в ряду: он переезжает', () => {
    expect(dropZone('before', inRow, 4)).toBe('before')
    expect(dropZone('after', inRow, 4)).toBe('after')
  })

  test('меньше четырёх — края открыты всем; чужие типы — ничего', () => {
    expect(dropZone('after', chat, 3)).toBe('after')
    expect(dropZone('before', session, 1)).toBe('before')
    expect(dropZone('replace', ['Files'], 2)).toBeNull()
    expect(dropZone('after', [DRAG_IN_ROW], 2)).toBeNull()
  })
})

describe('moveSplitter: прокручиваемый ряд (S2-R22б)', () => {
  test('ряд не прокручивается — как resizePanes по видимой ширине', () => {
    const row = { shares: [0.5, 0.5], panePx: [500, 500], viewPx: 1000, minPx: 320 }
    expect(moveSplitter(row, 0, -1000)).toEqual(resizePanes([0.5, 0.5], 0, -1000, 1000, 320))
  })

  test('окно уже 4 × минимум: разделитель всё равно двигается, левая панель растёт, правая не уже минимума', () => {
    const row = { shares: equalWidths(4), panePx: [320, 320, 320, 320], viewPx: 540, minPx: 320 }
    // resizePanes by the visible width is dead here: 2 × 320 > 0.5 × 540.
    expect(resizePanes(row.shares, 0, 100, 540, 320)).toEqual(row.shares)
    const out = moveSplitter(row, 0, 100)
    expect(Math.abs(sum(out) - 1)).toBeLessThan(1e-9)
    const total = 1380
    expect(out.map((w) => w * total)).toEqual([420, 320, 320, 320].map((px) => expect.closeTo(px, 6)))
    // The pane's share times the row it makes is the width drawn (paneMinScale): 420 px.
    const k = paneMinScale(out)
    expect(320 * k[0]!).toBeCloseTo(420, 6)
    expect(320 * k[1]!).toBeCloseTo(320, 6)
  })

  test('в прокручиваемом ряду левая панель не уже минимума', () => {
    const row = { shares: equalWidths(4), panePx: [320, 320, 320, 320], viewPx: 540, minPx: 320 }
    expect(moveSplitter(row, 1, -50)).toEqual(row.shares)
    const wide = { shares: [0.4, 0.2, 0.2, 0.2], panePx: [640, 320, 320, 320], viewPx: 540, minPx: 320 }
    const out = moveSplitter(wide, 0, -500)
    expect(out.map((w) => w * 1280)).toEqual([320, 320, 320, 320].map((px) => expect.closeTo(px, 6)))
  })

  test('paneMinScale: доля к самой узкой', () => {
    expect(paneMinScale([0.25, 0.25, 0.25, 0.25])).toEqual([1, 1, 1, 1])
    expect(paneMinScale([0.5, 0.25, 0.25])).toEqual([2, 1, 1])
    expect(paneMinScale([])).toEqual([])
  })
})

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
