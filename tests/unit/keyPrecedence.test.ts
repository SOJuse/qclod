import { describe, expect, test } from 'vitest'
import {
  resolveComposerKey,
  type ComposerContext,
  type KeyLike
} from '@renderer/input/keyPrecedence'

function key(partial: Partial<KeyLike>): KeyLike {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...partial
  } as KeyLike
}

function ctx(partial: Partial<ComposerContext> = {}): ComposerContext {
  return {
    text: '',
    popupOpen: false,
    hasSelection: false,
    caretAtStart: true,
    caretAtEnd: true,
    ...partial
  }
}

describe('resolveComposerKey', () => {
  test('Esc прерывает агента даже когда в поле есть текст', () => {
    // A half-typed draft must never make the agent uninterruptible.
    expect(resolveComposerKey(key({ key: 'Escape' }), ctx({ text: 'половина мысли' }))).toBe(
      'interrupt'
    )
  })

  test('Esc при открытой подсказке сначала закрывает её', () => {
    expect(resolveComposerKey(key({ key: 'Escape' }), ctx({ popupOpen: true }))).toBe('closePopup')
  })

  test('Enter отправляет, Shift+Enter переносит строку', () => {
    expect(resolveComposerKey(key({ key: 'Enter' }), ctx({ text: 'привет' }))).toBe('submit')
    expect(
      resolveComposerKey(key({ key: 'Enter', shiftKey: true }), ctx({ text: 'привет' }))
    ).toBe('newline')
  })

  test('Enter в пустом поле ничего не отправляет', () => {
    expect(resolveComposerKey(key({ key: 'Enter' }), ctx({ text: '' }))).toBe('insert')
  })

  test('стрелки при пустом поле дают историю, при непустом — курсор', () => {
    expect(resolveComposerKey(key({ key: 'ArrowUp' }), ctx({ text: '' }))).toBe('historyPrev')
    expect(resolveComposerKey(key({ key: 'ArrowDown' }), ctx({ text: '' }))).toBe('historyNext')

    expect(
      resolveComposerKey(
        key({ key: 'ArrowUp' }),
        ctx({ text: 'две\nстроки', caretAtStart: false })
      )
    ).toBe('caret')
  })

  test('стрелки ведут по подсказке, пока она открыта', () => {
    expect(resolveComposerKey(key({ key: 'ArrowUp' }), ctx({ popupOpen: true }))).toBe('popupNav')
    expect(resolveComposerKey(key({ key: 'Enter' }), ctx({ popupOpen: true }))).toBe('popupAccept')
  })

  test('Tab при открытом списке дописывает выбранное', () => {
    expect(resolveComposerKey(key({ key: 'Tab' }), ctx({ popupOpen: true }))).toBe('popupComplete')
  })

  test('/ в пустом поле просто печатается — список откроется из текста, модалки нет', () => {
    expect(resolveComposerKey(key({ key: '/' }), ctx({ text: '' }))).toBe('insert')
    // Mid-sentence a slash is just a slash — a path, a date, a fraction.
    expect(resolveComposerKey(key({ key: '/' }), ctx({ text: 'путь src' }))).toBe('insert')
  })

  test('@ открывает автодополнение по файлам проекта', () => {
    expect(resolveComposerKey(key({ key: '@' }), ctx({ text: '' }))).toBe('openMentions')
    expect(resolveComposerKey(key({ key: '@' }), ctx({ text: 'посмотри ' }))).toBe('openMentions')
  })

  test('Ctrl+V, Ctrl+Z, Ctrl+A остаются родным редактированием', () => {
    // The field is a plain textarea; the browser already does these correctly,
    // and intercepting them is how v1 broke undo.
    for (const code of ['KeyV', 'KeyZ', 'KeyA', 'KeyX', 'KeyC']) {
      expect(resolveComposerKey(key({ key: code.slice(3).toLowerCase(), code, ctrlKey: true }), ctx())).toBe(
        'native'
      )
    }
  })

  test('раскладка не ломает хоткеи', () => {
    // Ctrl+V on a Russian layout reports key "м"; only the physical key is
    // reliable. This was a Critical finding in v1.
    expect(resolveComposerKey(key({ key: 'м', code: 'KeyV', ctrlKey: true }), ctx())).toBe('native')
  })

  test('Tab без подсказки переключает режим разрешений', () => {
    expect(resolveComposerKey(key({ key: 'Tab', shiftKey: true }), ctx())).toBe('cyclePermissionMode')
  })

  test('обычная буква просто печатается', () => {
    expect(resolveComposerKey(key({ key: 'а', code: 'KeyF' }), ctx())).toBe('insert')
  })
})

describe('resolveComposerKey: вложение без текста', () => {
  test('Enter отправляет, когда прикреплён файл и текста нет', () => {
    expect(
      resolveComposerKey(key({ key: 'Enter' }), ctx({ text: '', hasAttachments: true }))
    ).toBe('submit')
  })

  test('пустое поле без вложений по-прежнему ничего не отправляет', () => {
    expect(resolveComposerKey(key({ key: 'Enter' }), ctx({ text: '' }))).toBe('insert')
  })
})
