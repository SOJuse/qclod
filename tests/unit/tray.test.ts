import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, Menu: {}, nativeImage: {}, nativeTheme: {}, Tray: class {} }))

import { TRAY_TOOLTIP, trayBitmap, trayStatus } from '../../src/main/tray'
import type { SessionStatus, TabState } from '../../src/shared/types'

const tab = (status: SessionStatus): TabState => ({ status }) as TabState

/** One BGRA pixel of a square bitmap. */
function pixel(buffer: Buffer, size: number, x: number, y: number): number[] {
  const at = (y * size + x) * 4
  return [...buffer.subarray(at, at + 4)]
}

describe('статус трея', () => {
  test('ждёт тебя важнее ошибки, ошибка важнее работы', () => {
    expect(trayStatus([tab('busy'), tab('waiting')])).toBe('waiting')
    expect(trayStatus([tab('error'), tab('busy')])).toBe('error')
    expect(trayStatus([tab('starting')])).toBe('working')
    expect(trayStatus([tab('idle'), tab('stopped')])).toBe('idle')
    expect(trayStatus([])).toBe('idle')
  })
})

describe('иконка в трее', () => {
  test('у каждого размера ровно size×size×4 байт', () => {
    for (const size of [16, 24, 32] as const) expect(trayBitmap(size, 'dark', 'idle')).toHaveLength(size * size * 4)
  })

  test('светлый глиф: белый с предумножением, без цвета, не пустой', () => {
    const bitmap = trayBitmap(16, 'light', 'idle')
    let opaque = 0
    for (let i = 0; i < bitmap.length; i += 4) {
      const a = bitmap[i + 3]!
      expect(bitmap[i]).toBe(a)
      expect(bitmap[i + 1]).toBe(a)
      expect(bitmap[i + 2]).toBe(a)
      if (a === 255) opaque++
    }
    expect(opaque).toBeGreaterThan(0)
  })

  test('тёмный глиф предумножен на альфу', () => {
    const bitmap = trayBitmap(24, 'dark', 'idle')
    for (let i = 0; i < bitmap.length; i += 4) {
      expect(bitmap[i]!).toBeLessThanOrEqual(bitmap[i + 3]!)
      expect(bitmap[i + 2]!).toBeLessThanOrEqual(bitmap[i + 3]!)
    }
  })

  test('точка «ждёт тебя» у правого нижнего угла, вокруг неё прозрачное кольцо', () => {
    const bitmap = trayBitmap(32, 'dark', 'waiting')
    expect(pixel(bitmap, 32, 24, 24)).toEqual([0x44, 0xb5, 0xf5, 255])
    expect(pixel(bitmap, 32, 24, 31)[3]).toBe(0)
  })

  test('цвета точек работы и ошибки', () => {
    expect(pixel(trayBitmap(32, 'dark', 'working'), 32, 24, 24)).toEqual([0xff, 0x8b, 0x6e, 255])
    expect(pixel(trayBitmap(32, 'dark', 'error'), 32, 24, 24)).toEqual([0x5a, 0x55, 0xf2, 255])
  })

  test('без статуса точки нет: глиф тот же, что и без неё', () => {
    const idle = trayBitmap(32, 'dark', 'idle')
    expect(pixel(idle, 32, 24, 24)).not.toEqual([0x44, 0xb5, 0xf5, 255])
  })
})

describe('подсказки', () => {
  test('тексты', () => {
    expect(TRAY_TOOLTIP.idle).toBe('Qclod')
    expect(TRAY_TOOLTIP.working).toBe('Qclod — работает')
    expect(TRAY_TOOLTIP.waiting).toBe('Qclod — ждёт тебя')
    expect(TRAY_TOOLTIP.error).toBe('Qclod — ошибка')
  })
})
