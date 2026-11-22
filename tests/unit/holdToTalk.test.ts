import { describe, expect, test } from 'vitest'
import { HoldToTalk, isVoiceKey } from '@renderer/voice/holdToTalk'

const key = (patch: Record<string, unknown> = {}) => ({
  key: ' ',
  code: 'Space',
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...patch
})

describe('HoldToTalk', () => {
  test('держал 400 мс и отпустил — start, потом stop', () => {
    const h = new HoldToTalk()
    expect(h.down(false, 1000)).toBe('start')
    expect(h.up(1400)).toBe('stop')
    // Отпущено — следующее нажатие снова начинает.
    expect(h.down(false, 2000)).toBe('start')
  })

  test('короткое нажатие — start, отпускание ничего, второе нажатие — stop', () => {
    const h = new HoldToTalk()
    expect(h.down(false, 0)).toBe('start')
    expect(h.up(399)).toBeNull()
    expect(h.down(true, 1500)).toBe('stop')
    expect(h.up(1550)).toBeNull()
    // Второе нажатие, удержанное долго, тоже только останавливает.
    expect(h.down(false, 3000)).toBe('start')
    expect(h.up(3100)).toBeNull()
    expect(h.down(true, 4000)).toBe('stop')
    expect(h.up(6000)).toBeNull()
  })

  test('blur во время удержания — stop; в режиме переключателя — null', () => {
    const h = new HoldToTalk()
    expect(h.down(false, 0)).toBe('start')
    expect(h.blur()).toBe('stop')
    // keyup после потери фокуса уже ничего не делает.
    expect(h.up(2000)).toBeNull()

    expect(h.down(false, 3000)).toBe('start')
    expect(h.up(3100)).toBeNull()
    expect(h.blur()).toBeNull()
  })

  test('своя длительность удержания', () => {
    const h = new HoldToTalk(1000)
    expect(h.down(false, 0)).toBe('start')
    expect(h.up(999)).toBeNull()
  })

  test('отпускание без нажатия и запись, кончившаяся сама, ничего не ломают', () => {
    const h = new HoldToTalk()
    expect(h.up(10)).toBeNull()
    expect(h.down(false, 0)).toBe('start')
    expect(h.up(100)).toBeNull()
    // Запись кончилась сама (ошибка): следующее нажатие — снова старт.
    expect(h.down(false, 5000)).toBe('start')
  })
})

describe('isVoiceKey', () => {
  test('{code: Space, ctrlKey: true} → true', () => {
    expect(isVoiceKey(key())).toBe(true)
  })

  test('с shiftKey (глобальная клавиша окна) → false', () => {
    expect(isVoiceKey(key({ shiftKey: true }))).toBe(false)
  })

  test('isComposing → false', () => {
    expect(isVoiceKey(key({ isComposing: true }))).toBe(false)
    expect(isVoiceKey(key({ keyCode: 229 }))).toBe(false)
  })

  test('русская раскладка (key: " ", code: Space) → true', () => {
    expect(isVoiceKey(key({ key: ' ', code: 'Space' }))).toBe(true)
  })

  test('без Ctrl, с Alt или Meta, другая клавиша → false', () => {
    expect(isVoiceKey(key({ ctrlKey: false }))).toBe(false)
    expect(isVoiceKey(key({ altKey: true }))).toBe(false)
    expect(isVoiceKey(key({ metaKey: true }))).toBe(false)
    expect(isVoiceKey(key({ code: 'KeyK', key: 'k' }))).toBe(false)
  })
})
