import { describe, expect, test } from 'vitest'
import { insertDictated } from '@renderer/voice/insertDictated'

describe('insertDictated', () => {
  test('в пустое поле', () => {
    expect(insertDictated('', 0, 'Привет.')).toEqual({ draft: 'Привет.', caret: 7 })
  })
  test('после слова — пробел и строчная', () => {
    expect(insertDictated('Сделай', 6, 'Тесты.')).toEqual({ draft: 'Сделай тесты.', caret: 13 })
  })
  test('после точки заглавная остаётся', () => {
    expect(insertDictated('Готово.', 7, 'Дальше.').draft).toBe('Готово. Дальше.')
  })
  test('аббревиатуры и латиница остаются', () => {
    expect(insertDictated('', 0, 'API падает.').draft).toBe('API падает.')
    expect(insertDictated('Сделай', 6, 'Claude проверит.').draft).toBe('Сделай Claude проверит.')
  })
  test('вставка в середину: курсор после вставленного', () => {
    expect(insertDictated('один три', 4, 'Два')).toEqual({ draft: 'один два три', caret: 8 })
  })
  test('знак препинания без пробела', () => {
    expect(insertDictated('Да', 2, ', конечно.').draft).toBe('Да, конечно.')
  })
  test('joinsPrevious даёт строчную даже после «.»', () => {
    expect(insertDictated('…длинная фраза', 14, 'Продолжение.', { joinsPrevious: true }).draft).toBe(
      '…длинная фраза продолжение.'
    )
    expect(insertDictated('Конец.', 6, 'Продолжение.', { joinsPrevious: true }).draft).toBe('Конец. продолжение.')
  })
  test('курсор за концом — вставка в конец; отрицательный — в начало', () => {
    expect(insertDictated('abc', 99, 'xyz').draft).toBe('abc xyz')
    expect(insertDictated('abc', -5, 'Xyz').draft).toBe('Xyz abc')
  })
  test('пустой текст ничего не меняет', () => {
    expect(insertDictated('abc', 1, '   ')).toEqual({ draft: 'abc', caret: 1 })
  })
  test('перевод строки слева — заглавная остаётся, пробел не нужен', () => {
    expect(insertDictated('Первая.\n', 8, 'Вторая.').draft).toBe('Первая.\nВторая.')
  })
  test('одна буква («Я») не делается строчной', () => {
    expect(insertDictated('Сделай', 6, 'Я проверю.').draft).toBe('Сделай Я проверю.')
  })
  test('текст обрезается по краям', () => {
    expect(insertDictated('', 0, '  Привет.  ').draft).toBe('Привет.')
  })
  test('справа цифра — пробел после', () => {
    expect(insertDictated('5', 0, 'Строк').draft).toBe('Строк 5')
  })
})
