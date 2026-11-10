import { describe, expect, test } from 'vitest'
import { bytes, clip, compactNumber, lines, plural, seconds } from '../../src/shared/format'

describe('format', () => {
  test('plural: один, несколько, много', () => {
    const f = (n: number): string => plural(n, 'файл', 'файла', 'файлов')
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111, 0].map(f)).toEqual([
      'файл', 'файла', 'файлов', 'файлов', 'файлов', 'файл', 'файла', 'файлов', 'файлов', 'файлов'
    ])
  })

  test('lines', () => {
    expect([1, 3, 10, 12, 21].map(lines)).toEqual(['1 строка', '3 строки', '10 строк', '12 строк', '21 строка'])
  })

  test('seconds', () => {
    expect(seconds(1200)).toBe('1,2 с')
    expect(seconds(42_000)).toBe('42 с')
    expect(seconds(200_000)).toBe('3 мин 20 с')
    expect(seconds(180_000)).toBe('3 мин')
    expect(seconds(9_990)).toBe('10 с')
  })

  test('compactNumber', () => {
    expect(compactNumber(15_000)).toBe('15k')
    expect(compactNumber(950)).toBe('950')
    expect(compactNumber(1500)).toBe('1,5k')
    expect(compactNumber(2_400_000)).toBe('2,4M')
  })

  test('bytes', () => {
    expect(bytes(12 * 1024)).toBe('12 КБ')
    expect(bytes(1.4 * 1024 * 1024)).toBe('1,4 МБ')
    expect(bytes(300)).toBe('300 Б')
  })

  test('clip берёт первую строку и режет', () => {
    expect(clip('первая\nвторая')).toBe('первая')
    expect(clip('abcdef', 4)).toBe('abc…')
  })
})
