import { describe, expect, test } from 'vitest'
import { MIN_COLS, MIN_ROWS, nextPtySize } from '@renderer/terminal/ptySize'

const real = { cols: 146, rows: 35 }

describe('nextPtySize', () => {
  test('нормальный замер применяется', () => {
    expect(nextPtySize({ width: 1156, height: 620 }, real, null)).toEqual(real)
  })

  test('скрытая вкладка не меняет размер pty', () => {
    // display:none makes the host 0x0, xterm then measures a degenerate 10x5,
    // and the real CLI reflows its entire full-screen UI to 10 columns —
    // rewrapping the whole conversation, twice per tab switch. Measured at
    // 10-20 s on a long session.
    expect(nextPtySize({ width: 0, height: 0 }, { cols: 10, rows: 5 }, real)).toBeNull()
  })

  test('нулевая только ширина — тоже не трогаем', () => {
    expect(nextPtySize({ width: 0, height: 620 }, { cols: 10, rows: 35 }, real)).toBeNull()
    expect(nextPtySize({ width: 1156, height: 0 }, { cols: 146, rows: 5 }, real)).toBeNull()
  })

  test('подозрительно мелкий замер отбрасывается даже при ненулевом хосте', () => {
    // Mid-layout the element can report a few pixels; the agent must not be
    // told the window shrank to a postage stamp.
    expect(nextPtySize({ width: 40, height: 20 }, { cols: MIN_COLS - 1, rows: 30 }, real)).toBeNull()
    expect(nextPtySize({ width: 40, height: 20 }, { cols: 100, rows: MIN_ROWS - 1 }, real)).toBeNull()
  })

  test('тот же размер не пересылается повторно', () => {
    expect(nextPtySize({ width: 1156, height: 620 }, real, real)).toBeNull()
  })

  test('изменение размера окна применяется', () => {
    const wider = { cols: 180, rows: 40 }
    expect(nextPtySize({ width: 1400, height: 700 }, wider, real)).toEqual(wider)
  })

  test('первый замер применяется, даже если прошлого нет', () => {
    expect(nextPtySize({ width: 800, height: 400 }, { cols: 100, rows: 24 }, null)).toEqual({
      cols: 100,
      rows: 24
    })
  })

  test('возврат на вкладку с тем же размером ничего не шлёт', () => {
    // Hidden -> visible must be a no-op when nothing actually changed, so the
    // agent never repaints just because the user looked at another tab.
    expect(nextPtySize({ width: 0, height: 0 }, { cols: 10, rows: 5 }, real)).toBeNull()
    expect(nextPtySize({ width: 1156, height: 620 }, real, real)).toBeNull()
  })
})
