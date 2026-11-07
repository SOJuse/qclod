import { describe, expect, test } from 'vitest'
import { ESC, toSequence } from '@renderer/input/keySequence'

function key(
  k: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean } {
  return {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false
  }
}

describe('toSequence', () => {
  test('Escape даёт один байт ESC', () => {
    expect(toSequence(key('Escape'))).toBe(ESC)
    expect(ESC.charCodeAt(0)).toBe(27)
  })

  test('Enter даёт возврат каретки', () => {
    expect(toSequence(key('Enter'))).toBe('\r')
  })

  test('Tab даёт табуляцию, Shift+Tab — обратную', () => {
    expect(toSequence(key('Tab'))).toBe('\t')
    expect(toSequence(key('Tab', { shift: true }))).toBe(`${ESC}[Z`)
  })

  test('Backspace даёт DEL', () => {
    expect(toSequence(key('Backspace')).charCodeAt(0)).toBe(127)
  })

  test('стрелки дают CSI-последовательности', () => {
    expect(toSequence(key('ArrowUp'))).toBe(`${ESC}[A`)
    expect(toSequence(key('ArrowDown'))).toBe(`${ESC}[B`)
    expect(toSequence(key('ArrowRight'))).toBe(`${ESC}[C`)
    expect(toSequence(key('ArrowLeft'))).toBe(`${ESC}[D`)
  })

  test('Ctrl+буква даёт управляющий символ', () => {
    expect(toSequence(key('c', { ctrl: true })).charCodeAt(0)).toBe(3)
    expect(toSequence(key('d', { ctrl: true })).charCodeAt(0)).toBe(4)
  })

  test('обычный символ уходит как есть', () => {
    expect(toSequence(key('/'))).toBe('/')
    expect(toSequence(key('п'))).toBe('п')
  })

  test('клавиши без текстового значения дают пустую строку', () => {
    expect(toSequence(key('Shift'))).toBe('')
    expect(toSequence(key('F5'))).toBe('')
  })
})
