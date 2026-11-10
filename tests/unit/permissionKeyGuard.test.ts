import { describe, expect, test } from 'vitest'
import {
  ARM_MS,
  FOCUS_BEFORE_MS,
  arrivalOf,
  claimFocusOffer,
  clearHeldKeys,
  createKeyGuard,
  focusedLongEnough
} from '@renderer/chat/permissionKeyGuard'

describe('createKeyGuard', () => {
  test('до фокуса карточки клавиши не принимаются', () => {
    expect(createKeyGuard().allows('Enter', 10_000)).toBe(false)
  })

  test('в первые 400 мс после фокуса клавиша ничего не делает', () => {
    const guard = createKeyGuard()
    guard.focus(1000, new Set())
    expect(guard.allows('KeyA', 1000 + ARM_MS - 1)).toBe(false)
  })

  test('после взвода свежая клавиша принимается', () => {
    const guard = createKeyGuard()
    guard.focus(1000, new Set())
    expect(guard.allows('KeyA', 1000 + ARM_MS)).toBe(true)
  })

  test('Enter, зажатый до появления карточки, не одобряет, пока его не отпустят', () => {
    const guard = createKeyGuard()
    const held = new Set(['Enter'])
    guard.focus(1000, held)
    expect(guard.allows('Enter', 5000)).toBe(false)
    guard.released('Enter')
    expect(guard.allows('Enter', 5000)).toBe(true)
  })

  test('зажатая другая клавиша не мешает свежей', () => {
    const guard = createKeyGuard()
    guard.focus(1000, new Set(['Enter']))
    expect(guard.allows('KeyA', 5000)).toBe(true)
  })
})

describe('focusedLongEnough', () => {
  test('окно не в фокусе — нет', () => {
    expect(focusedLongEnough(null, 5000)).toBe(false)
  })

  test('в фокусе меньше секунды до запроса — нет', () => {
    expect(focusedLongEnough(4500, 5000)).toBe(false)
    expect(focusedLongEnough(5000 - FOCUS_BEFORE_MS + 1, 5000)).toBe(false)
  })

  test('в фокусе секунду и дольше до запроса — да', () => {
    expect(focusedLongEnough(5000 - FOCUS_BEFORE_MS, 5000)).toBe(true)
  })
})

describe('потеря фокуса окном', () => {
  test('снимает зажатые клавиши со всех карточек', () => {
    const guard = createKeyGuard()
    guard.focus(1000, new Set(['Enter']))
    clearHeldKeys()
    expect(guard.allows('Enter', 5000)).toBe(true)
  })
})

describe('фокус карточки предлагается один раз на запрос', () => {
  test('время прихода запоминается по запросу и не сбрасывается при новом монтировании', () => {
    expect(arrivalOf('r-arr', 100)).toBe(100)
    expect(arrivalOf('r-arr', 5000)).toBe(100)
    expect(arrivalOf('r-other', 5000)).toBe(5000)
  })

  test('второе монтирование той же карточки фокус уже не берёт', () => {
    expect(claimFocusOffer('r-claim')).toBe(true)
    expect(claimFocusOffer('r-claim')).toBe(false)
    expect(claimFocusOffer('r-claim-2')).toBe(true)
  })
})
