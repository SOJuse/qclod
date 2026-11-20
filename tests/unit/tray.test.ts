import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, Menu: {}, nativeImage: {}, Tray: class {} }))

import { trayBitmap } from '../../src/main/tray'

/** One BGRA pixel of a square bitmap. */
function pixel(buffer: Buffer, size: number, x: number, y: number): number[] {
  const at = (y * size + x) * 4
  return [...buffer.subarray(at, at + 4)]
}

describe('иконка в трее', () => {
  test('растровая, а не SVG: у каждого размера ровно size×size×4 байт', () => {
    for (const size of [16, 24, 32]) expect(trayBitmap(size)).toHaveLength(size * size * 4)
  })

  test('в центре непрозрачный акцентный цвет, в углу пусто', () => {
    const size = 16
    const bitmap = trayBitmap(size)
    // BGRA: #6E8BFF
    expect(pixel(bitmap, size, 8, 8)).toEqual([0xff, 0x8b, 0x6e, 255])
    expect(pixel(bitmap, size, 0, 0)).toEqual([0, 0, 0, 0])
  })

  test('цвет предумножен на альфу: полупрозрачный край не светлее фона', () => {
    const size = 32
    const bitmap = trayBitmap(size)
    for (let i = 0; i < bitmap.length; i += 4) {
      const alpha = bitmap[i + 3]!
      expect(bitmap[i]!).toBeLessThanOrEqual(alpha)
      expect(bitmap[i + 1]!).toBeLessThanOrEqual(alpha)
      expect(bitmap[i + 2]!).toBeLessThanOrEqual(alpha)
    }
  })
})
