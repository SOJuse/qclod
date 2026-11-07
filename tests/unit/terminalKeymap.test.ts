import { describe, expect, test } from 'vitest'
import { resolveTerminalKey, type TerminalKeyContext } from '@renderer/terminal/keymap'

function key(
  k: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean } {
  return {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: false
  }
}

const withSelection: TerminalKeyContext = { hasSelection: true }
const noSelection: TerminalKeyContext = { hasSelection: false }

describe('resolveTerminalKey', () => {
  test('Ctrl+C при выделении даёт copy', () => {
    expect(resolveTerminalKey(key('c', { ctrl: true }), withSelection)).toBe('copy')
  })

  test('Ctrl+C без выделения даёт toPty', () => {
    expect(resolveTerminalKey(key('c', { ctrl: true }), noSelection)).toBe('toPty')
  })

  test('Ctrl+Shift+C даёт copy даже без выделения', () => {
    expect(resolveTerminalKey(key('C', { ctrl: true, shift: true }), noSelection)).toBe('copy')
  })

  test('Ctrl+V даёт paste', () => {
    expect(resolveTerminalKey(key('v', { ctrl: true }), noSelection)).toBe('paste')
  })

  test('Ctrl+Shift+V даёт paste', () => {
    expect(resolveTerminalKey(key('V', { ctrl: true, shift: true }), noSelection)).toBe('paste')
  })

  test('Ctrl+A даёт selectAll, а не управляющий символ', () => {
    expect(resolveTerminalKey(key('a', { ctrl: true }), noSelection)).toBe('selectAll')
  })

  test('Ctrl+F даёт search, Ctrl+L даёт clear', () => {
    expect(resolveTerminalKey(key('f', { ctrl: true }), noSelection)).toBe('search')
    expect(resolveTerminalKey(key('l', { ctrl: true }), noSelection)).toBe('clear')
  })

  test('Ctrl+Plus, Ctrl+Minus, Ctrl+0 меняют размер шрифта', () => {
    expect(resolveTerminalKey(key('+', { ctrl: true }), noSelection)).toBe('fontUp')
    expect(resolveTerminalKey(key('=', { ctrl: true }), noSelection)).toBe('fontUp')
    expect(resolveTerminalKey(key('-', { ctrl: true }), noSelection)).toBe('fontDown')
    expect(resolveTerminalKey(key('0', { ctrl: true }), noSelection)).toBe('fontReset')
  })

  test('Ctrl+Backquote переключает фокус', () => {
    expect(resolveTerminalKey(key('`', { ctrl: true }), noSelection)).toBe('toggleFocus')
  })

  test('обычные клавиши уходят в pty', () => {
    expect(resolveTerminalKey(key('a'), noSelection)).toBe('toPty')
    expect(resolveTerminalKey(key('Escape'), noSelection)).toBe('toPty')
    expect(resolveTerminalKey(key('ArrowUp'), noSelection)).toBe('toPty')
    expect(resolveTerminalKey(key('Enter'), noSelection)).toBe('toPty')
  })

  test('Ctrl+D и Ctrl+Z остаются управляющими символами агента', () => {
    expect(resolveTerminalKey(key('d', { ctrl: true }), noSelection)).toBe('toPty')
    expect(resolveTerminalKey(key('z', { ctrl: true }), noSelection)).toBe('toPty')
  })

  test('регистр клавиши не важен', () => {
    expect(resolveTerminalKey(key('A', { ctrl: true }), noSelection)).toBe('selectAll')
    expect(resolveTerminalKey(key('F', { ctrl: true }), noSelection)).toBe('search')
  })
})

describe('раскладка клавиатуры не влияет на хоткеи терминала', () => {
  const ru = (
    code: string,
    key: string,
    mods: { ctrl?: boolean; shift?: boolean } = {}
  ): { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean } => ({
    key,
    code,
    ctrlKey: mods.ctrl ?? true,
    shiftKey: mods.shift ?? false,
    altKey: false,
    metaKey: false
  })

  test('Ctrl+C на русской раскладке копирует при выделении', () => {
    expect(resolveTerminalKey(ru('KeyC', 'с'), withSelection)).toBe('copy')
  })

  test('Ctrl+C на русской раскладке прерывает без выделения', () => {
    expect(resolveTerminalKey(ru('KeyC', 'с'), noSelection)).toBe('toPty')
  })

  test('Ctrl+V, Ctrl+A, Ctrl+F, Ctrl+L работают на русской раскладке', () => {
    expect(resolveTerminalKey(ru('KeyV', 'м'), noSelection)).toBe('paste')
    expect(resolveTerminalKey(ru('KeyA', 'ф'), noSelection)).toBe('selectAll')
    expect(resolveTerminalKey(ru('KeyF', 'а'), noSelection)).toBe('search')
    expect(resolveTerminalKey(ru('KeyL', 'д'), noSelection)).toBe('clear')
  })

  test('Ctrl+Backquote переключает фокус на русской раскладке', () => {
    expect(resolveTerminalKey(ru('Backquote', 'ё'), noSelection)).toBe('toggleFocus')
  })
})
