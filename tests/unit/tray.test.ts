import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { pinPlatform } from './platform'

vi.mock('electron', () => ({ app: {}, Menu: {}, nativeImage: {}, nativeTheme: {}, Tray: class {} }))

import { nativeImage } from 'electron'
import { TRAY_TOOLTIP, trayBitmap, trayImageFor, trayStatus, trayTitleFor } from '../../src/main/tray'
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

describe('refresh', () => {
  // The Windows tray: icon by bitmap, no menu-bar title (the Mac one is at the end of the file).
  pinPlatform('win32', { beforeEach, afterEach })
  test('два одинаковых вызова — один setImage', async () => {
    vi.resetModules()
    const setImage = vi.fn()
    class FakeTray {
      setImage = setImage
      setToolTip = vi.fn()
      setContextMenu = vi.fn()
      on = vi.fn()
    }
    vi.doMock('electron', () => ({
      app: {},
      Menu: { buildFromTemplate: () => ({}) },
      nativeImage: { createEmpty: () => ({ addRepresentation: () => undefined }) },
      nativeTheme: {},
      Tray: FakeTray
    }))
    const { createTray } = await import('../../src/main/tray')
    let tabs = [tab('idle')]
    const tray = createTray({
      getWindow: () => null,
      getTabs: () => tabs,
      onActivateTab: () => undefined,
      toggleWindow: () => undefined,
      getTone: () => 'dark'
    })
    tray.refresh()
    tray.refresh()
    expect(setImage).not.toHaveBeenCalled()
    tabs = [tab('waiting')]
    tray.refresh()
    tray.refresh()
    expect(setImage).toHaveBeenCalledTimes(1)
    vi.doUnmock('electron')
  })
})

describe('«не спать» в меню', () => {
  pinPlatform('win32', { beforeEach, afterEach })
  async function build(active: boolean, tabs: TabState[]) {
    vi.resetModules()
    const built: Array<Array<{ label?: string; enabled?: boolean }>> = []
    const setToolTip = vi.fn()
    class FakeTray {
      setToolTip = setToolTip
      setImage = vi.fn()
      setContextMenu = vi.fn()
      on = vi.fn()
    }
    vi.doMock('electron', () => ({
      app: { quit: vi.fn() },
      Menu: { buildFromTemplate: (t: never) => (built.push(t), {}) },
      nativeImage: { createEmpty: () => ({ addRepresentation: vi.fn() }) },
      nativeTheme: {},
      Tray: FakeTray
    }))
    const { createTray } = await import('../../src/main/tray')
    createTray({
      getWindow: () => null,
      getTabs: () => tabs,
      onActivateTab: () => undefined,
      toggleWindow: () => undefined,
      getTone: () => 'dark',
      isKeepingAwake: () => active
    })
    vi.doUnmock('electron')
    return { menu: built.at(-1)!, setToolTip }
  }

  test('при active в меню строка «Не даю компьютеру уснуть — агенты работают»', async () => {
    const on = await build(true, [tab('busy')])
    const row = on.menu.find((i) => i.label === 'Не даю компьютеру уснуть — агенты работают')
    expect(row?.enabled).toBe(false)
    const off = await build(false, [tab('busy')])
    expect(off.menu.some((i) => i.label?.startsWith('Не даю'))).toBe(false)
  })

  test('при active и статусе waiting подсказка — «Qclod — ждёт тебя»', async () => {
    const { setToolTip } = await build(true, [tab('waiting')])
    expect(setToolTip).toHaveBeenCalledWith('Qclod — ждёт тебя')
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

describe('значок в строке меню Mac', () => {
  test('на darwin — файл …Template.png из tray/, setTemplateImage(true)', () => {
    const setTemplateImage = vi.fn()
    const createFromPath = vi.fn(() => ({ setTemplateImage }))
    Object.assign(nativeImage, { createFromPath })
    trayImageFor('darwin', 'idle', '/res')
    expect(createFromPath).toHaveBeenCalledTimes(1)
    const path = (createFromPath.mock.calls[0] as unknown as [string])[0].split('\\').join('/')
    expect(path).toBe('/res/tray/trayTemplate.png')
    expect(path.endsWith('Template.png')).toBe(true)
    expect(setTemplateImage).toHaveBeenCalledWith(true)
  })

  test('статус на Mac — заголовком, а не цветом', () => {
    expect(trayTitleFor('idle')).toBe('')
    expect(trayTitleFor('working')).toBe('•')
    expect(trayTitleFor('waiting')).toBe('!')
    expect(trayTitleFor('error')).toBe('!')
  })

  test('на Windows файлов нет: рисованный битмап', () => {
    const createFromPath = vi.fn()
    const addRepresentation = vi.fn()
    Object.assign(nativeImage, { createFromPath, createEmpty: () => ({ addRepresentation }) })
    trayImageFor('win32', 'working', '/res')
    expect(createFromPath).not.toHaveBeenCalled()
    expect(addRepresentation).toHaveBeenCalledTimes(3)
  })
})
