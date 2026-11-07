import { describe, expect, test } from 'vitest'
import { nextPassthrough, shouldEnterPassthrough, shouldExitPassthrough } from '@renderer/input/passthrough'

describe('shouldEnterPassthrough', () => {
  test('строка, начинающаяся с /, включает проброс', () => {
    expect(shouldEnterPassthrough('/')).toBe(true)
    expect(shouldEnterPassthrough('/comp')).toBe(true)
  })

  test('пробел перед / не включает проброс', () => {
    expect(shouldEnterPassthrough(' /compact')).toBe(false)
  })

  test('слэш в середине не включает проброс', () => {
    expect(shouldEnterPassthrough('src/main')).toBe(false)
  })

  test('пустая строка не включает проброс', () => {
    expect(shouldEnterPassthrough('')).toBe(false)
  })
})

describe('shouldExitPassthrough', () => {
  test('стирание / выключает проброс', () => {
    expect(shouldExitPassthrough('')).toBe(true)
  })

  test('строка без ведущего / выключает проброс', () => {
    expect(shouldExitPassthrough('compact')).toBe(true)
  })

  test('пока строка начинается с /, проброс держится', () => {
    expect(shouldExitPassthrough('/compact')).toBe(false)
  })
})

describe('nextPassthrough', () => {
  test('выключен и набран / — включается', () => {
    expect(nextPassthrough(false, '/')).toBe(true)
  })

  test('включён и строка всё ещё начинается с / — остаётся включённым', () => {
    expect(nextPassthrough(true, '/compact')).toBe(true)
  })

  test('включён и всё стёрли — выключается', () => {
    expect(nextPassthrough(true, '')).toBe(false)
  })

  test('выключен и текст без / — остаётся выключенным', () => {
    expect(nextPassthrough(false, 'hello')).toBe(false)
  })

  test('вставка текста, начинающегося с /, тоже включает проброс', () => {
    expect(nextPassthrough(false, '/clear')).toBe(true)
  })
})
