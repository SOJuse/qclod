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
  readDrop,
  resizePanes,
  rowLayout
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

const MIN = 320
const drawn = (shares: number[], view: number): number[] => rowLayout(shares, view, MIN).px
/** One splitter move on the row as drawn, then the row drawn again from the shares it gives. */
const step = (shares: number[], view: number, splitter: number, delta: number): number[] =>
  moveSplitter({ shares, viewPx: view, minPx: MIN }, splitter, delta)

describe('rowLayout: ряд, который помещается, не прокручивается (раунд 2, п. 1)', () => {
  test('[.17,.17,.17,.49] в ряду 1400 — без прокрутки, постоянный минимум', () => {
    const row = rowLayout([0.17, 0.17, 0.17, 0.49], 1400, MIN)
    expect(row.scrolls).toBe(false)
    expect(sum(row.px)).toBeCloseTo(1400, 6)
    expect(row.px.slice(0, 3)).toEqual([320, 320, 320])
    expect(row.px[3]).toBeCloseTo(440, 6)
  })

  test('[.8,.2] в ряду 1000 — без прокрутки', () => {
    const row = rowLayout([0.8, 0.2], 1000, MIN)
    expect(row.scrolls).toBe(false)
    expect(row.px[0]).toBeCloseTo(680, 6)
    expect(row.px[1]).toBe(320)
  })

  test('доли, которые помещаются, рисуются как есть; ровно N × минимум — ещё без прокрутки', () => {
    expect(rowLayout([0.25, 0.75], 2000, MIN).px).toEqual([500, 1500])
    expect(rowLayout(equalWidths(4), 1280, MIN)).toEqual({ scrolls: false, px: [320, 320, 320, 320] })
    expect(rowLayout([1], 200, MIN)).toEqual({ scrolls: false, px: [200] })
  })

  test('уже N × минимум — прокрутка, каждая панель не уже минимума', () => {
    const row = rowLayout(equalWidths(4), 540, MIN)
    expect(row.scrolls).toBe(true)
    for (const w of row.px) expect(w).toBeGreaterThan(MIN)
    expect(sum(row.px)).toBeGreaterThan(540)
  })
})

describe('moveSplitter (раунд 2, п. 2)', () => {
  test('ряд помещается — как resizePanes по видимой ширине', () => {
    expect(step([0.5, 0.5], 1000, 0, -1000)).toEqual(resizePanes([0.5, 0.5], 0, -1000, 1000, MIN))
    expect(step([0.3, 0.3, 0.4], 1500, 1, 16)).toEqual(resizePanes([0.3, 0.3, 0.4], 1, 16, 1500, MIN))
  })

  test('ряд помещается, доли из большого окна под минимумом: разделитель идёт от нарисованного', () => {
    const shares = [0.17, 0.17, 0.17, 0.49]
    // By the shares alone the first pair is dead: 2 × 320 > 0.34 × 1400.
    expect(resizePanes(shares, 0, 16, 1400, MIN)).toEqual(shares)
    const before = drawn(shares, 1400)
    const after = drawn(step(shares, 1400, 2, 16), 1400)
    expect(after[2]! - before[2]!).toBeCloseTo(16, 6)
    expect(rowLayout(step(shares, 1400, 2, 16), 1400, MIN).scrolls).toBe(false)
  })

  test('[.1,.3,.3,.3] в тесном ряду: стрелка вправо — нарисованная левая панель шире на 16 px', () => {
    const shares = [0.1, 0.3, 0.3, 0.3]
    for (const view of [540, 840, 1100]) {
      const before = drawn(shares, view)
      const after = drawn(step(shares, view, 0, 16), view)
      expect(after[0]! - before[0]!).toBeCloseTo(16, 6)
      // The splitter moved, the row did not change its width.
      expect(sum(after)).toBeCloseTo(sum(before), 6)
    }
  })

  test('все по минимуму в тесном ряду: двигается в обе стороны', () => {
    const shares = equalWidths(4)
    const before = drawn(shares, 540)
    expect(drawn(step(shares, 540, 0, 16), 540)[0]! - before[0]!).toBeCloseTo(16, 6)
    expect(drawn(step(shares, 540, 1, -16), 540)[1]! - before[1]!).toBeCloseTo(-16, 6)
  })

  test('любое распределение: стрелки идут за шагом, пока есть куда; ни одна панель не уже минимума', () => {
    for (const shares of [
      [0.1, 0.3, 0.3, 0.3],
      [0.3, 0.3, 0.3, 0.1],
      [0.7, 0.1, 0.1, 0.1],
      [0.05, 0.05, 0.45, 0.45],
      equalWidths(3)
    ]) {
      for (let s = 0; s < shares.length - 1; s++) {
        for (const d of [16, -16]) {
          const before = drawn(shares, 600)
          const after = drawn(step(shares, 600, s, d), 600)
          const edge = (px: number[]): number => sum(px.slice(0, s + 1))
          const room = d > 0 ? sum(before.slice(s + 1).map((w) => w - MIN)) : sum(before.slice(0, s + 1).map((w) => w - MIN))
          expect(edge(after) - edge(before)).toBeCloseTo(Math.sign(d) * Math.min(16, room), 6)
          for (const w of after) expect(w).toBeGreaterThanOrEqual(MIN - 1e-9)
        }
      }
    }
  })

  test('сохранённые доли в том же окне дают ту же картину', () => {
    let shares = [0.1, 0.3, 0.3, 0.3]
    for (const [s, d] of [
      [0, 40],
      [2, -100],
      [1, 300]
    ] as const) {
      const pushed = step(shares, 700, s, d)
      expect(Math.abs(sum(pushed) - 1)).toBeLessThan(1e-9)
      // What is written is what is drawn: drawn from it again, then moved by nothing, it stays.
      expect(drawn(step(pushed, 700, s, 0), 700)).toEqual(drawn(pushed, 700).map((w) => expect.closeTo(w, 6)))
      shares = pushed
    }
  })

  test('в прокручиваемом ряду левая панель не уже минимума, правая — тоже', () => {
    const shares = equalWidths(4)
    const before = drawn(shares, 540)
    const far = drawn(step(shares, 540, 0, -5000), 540)
    expect(far[0]).toBeCloseTo(MIN, 6)
    expect(sum(far)).toBeCloseTo(sum(before), 6)
    const right = drawn(step(shares, 540, 2, 5000), 540)
    expect(right[3]).toBeCloseTo(MIN, 6)
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
