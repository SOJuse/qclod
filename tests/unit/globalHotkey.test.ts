import { describe, expect, test, vi } from 'vitest'
import { HotkeyRegistrar, type ShortcutApi } from '@main/hotkey/globalHotkey'

function fakeApi(taken: string[] = []): ShortcutApi & { registered: string[] } {
  const registered: string[] = []
  return {
    registered,
    register: (accelerator, _cb) => {
      if (taken.includes(accelerator)) return false
      registered.push(accelerator)
      return true
    },
    unregister: (accelerator) => {
      const index = registered.indexOf(accelerator)
      if (index !== -1) registered.splice(index, 1)
    },
    isRegistered: (accelerator) => registered.includes(accelerator)
  }
}

describe('HotkeyRegistrar', () => {
  test('успешная регистрация даёт ok true', () => {
    const registrar = new HotkeyRegistrar(fakeApi(), () => undefined)
    const result = registrar.apply('Control+Shift+Space')
    expect(result.ok).toBe(true)
    expect(result.accelerator).toBe('Control+Shift+Space')
    expect(result.reason).toBeUndefined()
  })

  test('занятая комбинация даёт ok false с причиной, а не исключение', () => {
    // Review Focus 3: the user must learn why the window will not appear.
    const registrar = new HotkeyRegistrar(fakeApi(['Control+Shift+Space']), () => undefined)
    let result
    expect(() => {
      result = registrar.apply('Control+Shift+Space')
    }).not.toThrow()
    expect(result!.ok).toBe(false)
    expect(result!.reason).toBeTruthy()
    expect(result!.reason).toContain('Control+Shift+Space')
  })

  test('смена комбинации снимает предыдущую регистрацию', () => {
    const api = fakeApi()
    const registrar = new HotkeyRegistrar(api, () => undefined)
    registrar.apply('Control+Shift+Space')
    registrar.apply('Control+Alt+Q')

    expect(api.registered).toEqual(['Control+Alt+Q'])
  })

  test('неудачная регистрация не оставляет старую висеть', () => {
    const api = fakeApi(['Control+Alt+Q'])
    const registrar = new HotkeyRegistrar(api, () => undefined)
    registrar.apply('Control+Shift+Space')
    registrar.apply('Control+Alt+Q')

    expect(api.registered).toEqual([])
  })

  test('нажатие комбинации зовёт обработчик', () => {
    const toggle = vi.fn()
    let captured: (() => void) | undefined
    const api: ShortcutApi = {
      register: (_a, cb) => {
        captured = cb
        return true
      },
      unregister: () => undefined,
      isRegistered: () => false
    }
    new HotkeyRegistrar(api, toggle).apply('Control+Shift+Space')
    captured?.()
    expect(toggle).toHaveBeenCalledOnce()
  })

  test('пустая комбинация отключает хоткей без ошибки', () => {
    const api = fakeApi()
    const registrar = new HotkeyRegistrar(api, () => undefined)
    registrar.apply('Control+Shift+Space')
    const result = registrar.apply('')

    expect(result.ok).toBe(true)
    expect(api.registered).toEqual([])
  })

  test('последнее состояние доступно для интерфейса', () => {
    const registrar = new HotkeyRegistrar(fakeApi(['X']), () => undefined)
    registrar.apply('X')
    expect(registrar.status.ok).toBe(false)
  })
})
