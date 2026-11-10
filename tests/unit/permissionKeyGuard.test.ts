import { describe, expect, test } from 'vitest'
import { ARM_MS, createKeyGuard } from '@renderer/chat/permissionKeyGuard'

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
