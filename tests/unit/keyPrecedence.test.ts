import { describe, expect, test } from 'vitest'
import {
  resolveComposerKey,
  type ComposerContext,
  type KeyLike
} from '@renderer/input/keyPrecedence'

function key(k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): KeyLike {
  return {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: false
  }
}

function ctx(patch: Partial<ComposerContext> = {}): ComposerContext {
  return {
    text: '',
    passthrough: false,
    popupOpen: false,
    menuActive: false,
    hasSelection: false,
    caretAtStart: true,
    caretAtEnd: true,
    ...patch
  }
}

describe('таблица приоритетов: строки сверху вниз', () => {
  test('Esc даёт toPty даже когда в поле есть текст', () => {
    expect(resolveComposerKey(key('Escape'), ctx({ text: 'набрано' }))).toBe('toPty')
  })

  test('Esc даёт toPty и в режиме проброса', () => {
    expect(resolveComposerKey(key('Escape'), ctx({ text: '/comp', passthrough: true }))).toBe(
      'toPty'
    )
  })

  test('Esc даёт toPty даже при открытом попапе', () => {
    expect(resolveComposerKey(key('Escape'), ctx({ popupOpen: true }))).toBe('closePopup')
  })

  test('Ctrl+Backquote всегда даёт toggleFocus', () => {
    expect(resolveComposerKey(key('`', { ctrl: true }), ctx())).toBe('toggleFocus')
    expect(
      resolveComposerKey(key('`', { ctrl: true }), ctx({ passthrough: true, popupOpen: true }))
    ).toBe('toggleFocus')
  })

  test('Ctrl+V всегда даёт paste', () => {
    expect(resolveComposerKey(key('v', { ctrl: true }), ctx())).toBe('paste')
    expect(resolveComposerKey(key('v', { ctrl: true }), ctx({ passthrough: true }))).toBe('paste')
  })

  test('Ctrl+C с выделением даёт copy, без выделения — toPty', () => {
    expect(resolveComposerKey(key('c', { ctrl: true }), ctx({ hasSelection: true }))).toBe('copy')
    expect(resolveComposerKey(key('c', { ctrl: true }), ctx({ hasSelection: false }))).toBe('toPty')
  })

  test('Tab при открытом попапе даёт popupAccept', () => {
    expect(resolveComposerKey(key('Tab'), ctx({ popupOpen: true }))).toBe('popupAccept')
    expect(resolveComposerKey(key('Tab', { shift: true }), ctx({ popupOpen: true }))).toBe(
      'popupAccept'
    )
  })

  test('Tab без попапа даёт toPty', () => {
    expect(resolveComposerKey(key('Tab'), ctx())).toBe('toPty')
    expect(resolveComposerKey(key('Tab', { shift: true }), ctx({ text: 'что-то' }))).toBe('toPty')
  })

  test('сам символ / в пустом поле уже уходит агенту', () => {
    // Otherwise the slash stays in our field, the CLI never sees it, and the
    // command arrives as "menu" instead of "/menu".
    expect(resolveComposerKey(key('/'), ctx({ text: '' }))).toBe('toPty')
  })

  test('/ в середине текста остаётся обычным вводом', () => {
    expect(resolveComposerKey(key('/'), ctx({ text: 'src' }))).toBe('insert')
  })

  test('печатная клавиша в режиме проброса даёт toPty', () => {
    expect(resolveComposerKey(key('c'), ctx({ text: '/', passthrough: true }))).toBe('toPty')
    expect(resolveComposerKey(key('Backspace'), ctx({ text: '/c', passthrough: true }))).toBe(
      'toPty'
    )
  })

  test('Enter в режиме проброса даёт toPty', () => {
    expect(resolveComposerKey(key('Enter'), ctx({ text: '/compact', passthrough: true }))).toBe(
      'toPty'
    )
  })

  test('Shift+Enter в режиме проброса тоже уходит агенту', () => {
    expect(
      resolveComposerKey(key('Enter', { shift: true }), ctx({ text: '/c', passthrough: true }))
    ).toBe('toPty')
  })

  test('Enter с текстом даёт submit', () => {
    expect(resolveComposerKey(key('Enter'), ctx({ text: 'привет' }))).toBe('submit')
  })

  test('Enter с пустым полем уходит агенту (подтверждение меню)', () => {
    expect(resolveComposerKey(key('Enter'), ctx({ text: '' }))).toBe('toPty')
  })

  test('Enter при открытом попапе выбирает пункт', () => {
    expect(resolveComposerKey(key('Enter'), ctx({ text: '@src', popupOpen: true }))).toBe(
      'popupAccept'
    )
  })

  test('Shift+Enter даёт newline', () => {
    expect(resolveComposerKey(key('Enter', { shift: true }), ctx({ text: 'строка' }))).toBe(
      'newline'
    )
  })

  test('стрелки при открытом попапе дают popupNav', () => {
    expect(resolveComposerKey(key('ArrowUp'), ctx({ popupOpen: true }))).toBe('popupNav')
    expect(resolveComposerKey(key('ArrowDown'), ctx({ popupOpen: true, text: 'a' }))).toBe(
      'popupNav'
    )
  })

  test('стрелки при пустом поле и активном меню дают toPty', () => {
    expect(resolveComposerKey(key('ArrowUp'), ctx({ text: '', menuActive: true }))).toBe('toPty')
    expect(resolveComposerKey(key('ArrowDown'), ctx({ text: '', menuActive: true }))).toBe('toPty')
  })

  test('стрелки при пустом поле без меню дают historyPrev/historyNext', () => {
    expect(resolveComposerKey(key('ArrowUp'), ctx({ text: '' }))).toBe('historyPrev')
    expect(resolveComposerKey(key('ArrowDown'), ctx({ text: '' }))).toBe('historyNext')
  })

  test('стрелки при непустом поле дают caret', () => {
    const withText = ctx({ text: 'строка', caretAtStart: false, caretAtEnd: false })
    expect(resolveComposerKey(key('ArrowUp'), withText)).toBe('caret')
    expect(resolveComposerKey(key('ArrowDown'), withText)).toBe('caret')
  })

  test('стрелка вверх у самого начала текста всё же открывает историю', () => {
    expect(
      resolveComposerKey(key('ArrowUp'), ctx({ text: 'строка', caretAtStart: true }))
    ).toBe('historyPrev')
  })

  test('стрелка вниз у самого конца текста идёт по истории', () => {
    expect(
      resolveComposerKey(key('ArrowDown'), ctx({ text: 'строка', caretAtEnd: true }))
    ).toBe('historyNext')
  })

  test('горизонтальные стрелки всегда двигают курсор', () => {
    expect(resolveComposerKey(key('ArrowLeft'), ctx({ text: '' }))).toBe('caret')
    expect(resolveComposerKey(key('ArrowRight'), ctx({ text: '', menuActive: true }))).toBe('caret')
  })

  test('обычный ввод вставляет символ в поле', () => {
    expect(resolveComposerKey(key('п'), ctx({ text: 'при' }))).toBe('insert')
    expect(resolveComposerKey(key('Backspace'), ctx({ text: 'при' }))).toBe('insert')
  })

  test('Ctrl+A, Ctrl+Z и Ctrl+X остаются родным редактированием поля', () => {
    for (const k of ['a', 'z', 'x', 'y']) {
      expect(resolveComposerKey(key(k, { ctrl: true }), ctx({ text: 'текст' }))).toBe('insert')
    }
  })
})

describe('раскладка клавиатуры не влияет на хоткеи', () => {
  // Chromium reports ev.key in the ACTIVE layout: on RU, Backquote is 'ё',
  // V is 'м', C is 'с'. Matching on ev.key kills every fixed hotkey for a user
  // typing Russian — including Ctrl+`, which spec 6.4 calls the mechanism that
  // "works always, no matter what".
  const ru = (code: string, key: string, mods: { ctrl?: boolean } = {}): KeyLike => ({
    key,
    code,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: false,
    altKey: false,
    metaKey: false
  })

  test('Ctrl+Backquote переключает фокус на русской раскладке', () => {
    expect(resolveComposerKey(ru('Backquote', 'ё', { ctrl: true }), ctx())).toBe('toggleFocus')
  })

  test('Ctrl+V вставляет на русской раскладке', () => {
    expect(resolveComposerKey(ru('KeyV', 'м', { ctrl: true }), ctx())).toBe('paste')
  })

  test('Ctrl+C на русской раскладке прерывает без выделения', () => {
    expect(resolveComposerKey(ru('KeyC', 'с', { ctrl: true }), ctx())).toBe('toPty')
  })

  test('Ctrl+C на русской раскладке копирует при выделении', () => {
    expect(resolveComposerKey(ru('KeyC', 'с', { ctrl: true }), ctx({ hasSelection: true }))).toBe(
      'copy'
    )
  })

  test('точка на русской раскладке не включает проброс', () => {
    // Slash-commands are about the CHARACTER the user typed, not the physical
    // key: on RU the Slash key produces '.', and treating it as '/' would turn
    // every sentence-ending period at the start of a line into a command.
    expect(resolveComposerKey(ru('Slash', '.'), ctx({ text: '' }))).toBe('insert')
  })

  test('слэш с любой клавиши включает проброс', () => {
    expect(resolveComposerKey(ru('Backslash', '/'), ctx({ text: '' }))).toBe('toPty')
  })
})
