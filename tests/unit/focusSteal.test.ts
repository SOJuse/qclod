import { describe, expect, test } from 'vitest'
import { shouldStealFocus, TYPING_GRACE_MS } from '@renderer/input/focusSteal'

describe('shouldStealFocus', () => {
  test('по умолчанию меню забирает фокус', () => {
    expect(
      shouldStealFocus({ autoFocusOnMenu: true, draft: '', msSinceTyping: 60_000 })
    ).toBe(true)
  })

  test('выключенная настройка запрещает перехват', () => {
    expect(
      shouldStealFocus({ autoFocusOnMenu: false, draft: '', msSinceTyping: 60_000 })
    ).toBe(false)
  })

  test('недописанный черновик защищён от перехвата', () => {
    // Otherwise output the agent merely printed could pull the keyboard away
    // mid-sentence, and the next keystrokes would answer a prompt instead.
    expect(
      shouldStealFocus({ autoFocusOnMenu: true, draft: 'полписанная мысль', msSinceTyping: 60_000 })
    ).toBe(false)
  })

  test('только что печатал — перехвата нет', () => {
    expect(
      shouldStealFocus({ autoFocusOnMenu: true, draft: '', msSinceTyping: TYPING_GRACE_MS - 1 })
    ).toBe(false)
  })

  test('после паузы перехват снова разрешён', () => {
    expect(
      shouldStealFocus({ autoFocusOnMenu: true, draft: '', msSinceTyping: TYPING_GRACE_MS + 1 })
    ).toBe(true)
  })

  test('пробелы в черновике считаются пустым полем', () => {
    expect(
      shouldStealFocus({ autoFocusOnMenu: true, draft: '   ', msSinceTyping: 60_000 })
    ).toBe(true)
  })
})
