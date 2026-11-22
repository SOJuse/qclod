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
    caretOnFirstLine: true,
    caretOnLastLine: true,
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
        ctx({ text: 'две\nстроки', caretOnFirstLine: false })
      )
    ).toBe('caret')
  })

  test('↑ на первой строке многострочного поля — история', () =>
    expect(
      resolveComposerKey(key({ key: 'ArrowUp' }), ctx({ text: 'а\nб', caretOnFirstLine: true }))
    ).toBe('historyPrev'))

  test('↑ на второй строке — движение каретки', () =>
    expect(
      resolveComposerKey(
        key({ key: 'ArrowUp' }),
        ctx({ text: 'а\nб', caretOnFirstLine: false, caretOnLastLine: true })
      )
    ).toBe('caret'))

  test('↓ на последней строке — история, выше — каретка', () => {
    expect(
      resolveComposerKey(key({ key: 'ArrowDown' }), ctx({ text: 'а\nб', caretOnLastLine: true }))
    ).toBe('historyNext')
    expect(
      resolveComposerKey(
        key({ key: 'ArrowDown' }),
        ctx({ text: 'а\nб', caretOnFirstLine: true, caretOnLastLine: false })
      )
    ).toBe('caret')
  })

  test('с выделением стрелки двигают каретку, истории нет', () => {
    expect(
      resolveComposerKey(key({ key: 'ArrowUp' }), ctx({ text: 'слово', hasSelection: true }))
    ).toBe('caret')
  })

  test('во время набора через IME стрелки отдаются ему, истории нет', () => {
    expect(
      resolveComposerKey(key({ key: 'ArrowUp', isComposing: true }), ctx({ text: '' }))
    ).toBe('native')
    expect(resolveComposerKey(key({ key: 'ArrowDown', keyCode: 229 }), ctx({ text: '' }))).toBe(
      'native'
    )
  })

  test('стрелки ведут по подсказке, пока она открыта', () => {
    expect(resolveComposerKey(key({ key: 'ArrowUp' }), ctx({ popupOpen: true }))).toBe('popupNav')
    expect(resolveComposerKey(key({ key: 'Enter' }), ctx({ popupOpen: true }))).toBe('popupAccept')
  })

  test('Shift+Enter при открытом списке переносит строку, а не выбирает', () => {
    expect(
      resolveComposerKey(key({ key: 'Enter', shiftKey: true }), ctx({ popupOpen: true, text: '/c' }))
    ).toBe('newline')
  })

  test('во время набора через IME клавиши не перехватываются', () => {
    // Enter confirms the IME candidate; taking it as «send» would lose the word.
    expect(
      resolveComposerKey(key({ key: 'Enter', isComposing: true }), ctx({ text: 'привет', popupOpen: true }))
    ).toBe('native')
    expect(resolveComposerKey(key({ key: 'Process', keyCode: 229 }), ctx({ text: 'привет' }))).toBe(
      'native'
    )
    expect(resolveComposerKey(key({ key: 'Escape', isComposing: true }), ctx())).toBe('native')
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

describe('ожидающее разрешение', () => {
  test('Enter на пустом поле при ожидающем разрешении — разрешить', () => {
    expect(resolveComposerKey(key({ key: 'Enter' }), ctx({ pendingPermission: true }))).toBe(
      'permissionAllow'
    )
  })

  test('Enter с текстом при ожидающем разрешении — отправка, не разрешение', () => {
    expect(
      resolveComposerKey(key({ key: 'Enter' }), ctx({ text: 'и ещё', pendingPermission: true }))
    ).toBe('submit')
  })

  test('Enter с вложением — отправка', () => {
    expect(
      resolveComposerKey(key({ key: 'Enter' }), ctx({ hasAttachments: true, pendingPermission: true }))
    ).toBe('submit')
  })

  test('Shift+Enter остаётся переводом строки', () => {
    expect(
      resolveComposerKey(key({ key: 'Enter', shiftKey: true }), ctx({ pendingPermission: true }))
    ).toBe('newline')
  })

  test('1 — разрешить, 2 — всё такое, 3 — до конца сессии, 4 — открыть поле причины', () => {
    const on = ctx({ pendingPermission: true })
    expect(resolveComposerKey(key({ key: '1', code: 'Digit1' }), on)).toBe('permissionAllow')
    expect(resolveComposerKey(key({ key: '2', code: 'Digit2' }), on)).toBe('permissionAllowAll')
    expect(resolveComposerKey(key({ key: '3', code: 'Digit3' }), on)).toBe('permissionAllowSession')
    expect(resolveComposerKey(key({ key: '4', code: 'Digit4' }), on)).toBe('permissionReason')
  })

  test('цифры с цифрового блока — те же ответы', () => {
    expect(
      resolveComposerKey(key({ key: '3', code: 'Numpad3' }), ctx({ pendingPermission: true }))
    ).toBe('permissionAllowSession')
  })

  test('цифра с текстом в поле — просто цифра', () => {
    expect(
      resolveComposerKey(key({ key: '2', code: 'Digit2' }), ctx({ text: 'п', pendingPermission: true }))
    ).toBe('insert')
  })

  test('цифра с Shift, Ctrl или Alt ничего не разрешает', () => {
    const on = ctx({ pendingPermission: true })
    expect(resolveComposerKey(key({ key: '!', code: 'Digit1', shiftKey: true }), on)).toBe('insert')
    expect(resolveComposerKey(key({ key: '2', code: 'Digit2', ctrlKey: true }), on)).toBe('insert')
    expect(resolveComposerKey(key({ key: '3', code: 'Digit3', altKey: true }), on)).toBe('insert')
  })

  test('A больше ничего не разрешает (решение 8)', () => {
    expect(
      resolveComposerKey(key({ key: 'ф', code: 'KeyA' }), ctx({ pendingPermission: true }))
    ).toBe('insert')
  })

  test('Ctrl+A остаётся выделением', () => {
    expect(
      resolveComposerKey(key({ key: 'a', code: 'KeyA', ctrlKey: true }), ctx({ pendingPermission: true }))
    ).toBe('native')
  })

  test('цифра без ожидающего разрешения — просто цифра', () => {
    expect(resolveComposerKey(key({ key: '1', code: 'Digit1' }), ctx())).toBe('insert')
  })

  test('Esc при ожидающем разрешении — открыть поле причины, а не прервать и не отказать сразу', () => {
    expect(resolveComposerKey(key({ key: 'Escape' }), ctx({ pendingPermission: true }))).toBe(
      'permissionReason'
    )
  })

  test('Esc при открытой подсказке и разрешении — сначала закрыть подсказку', () => {
    expect(
      resolveComposerKey(key({ key: 'Escape' }), ctx({ popupOpen: true, pendingPermission: true }))
    ).toBe('closePopup')
  })

  test('Esc без ожидающего разрешения по-прежнему прерывает', () => {
    expect(resolveComposerKey(key({ key: 'Escape' }), ctx())).toBe('interrupt')
  })

  test('клавиши метода ввода (IME) не разрешают и не отклоняют', () => {
    expect(
      resolveComposerKey(key({ key: 'Enter', isComposing: true }), ctx({ pendingPermission: true }))
    ).toBe('native')
    expect(
      resolveComposerKey(key({ key: 'Escape', keyCode: 229 }), ctx({ pendingPermission: true }))
    ).toBe('native')
  })
})

describe('открытый вопрос', () => {
  test('1–9 на карточке вопроса выбирают, Enter — дальше', () => {
    const on = ctx({ pendingQuestion: true })
    for (const digit of ['1', '5', '9']) {
      expect(resolveComposerKey(key({ key: digit, code: `Digit${digit}` }), on)).toBe('questionPick')
    }
    expect(resolveComposerKey(key({ key: '4', code: 'Numpad4' }), on)).toBe('questionPick')
    expect(resolveComposerKey(key({ key: 'Enter' }), on)).toBe('questionNext')
  })

  test('0, Shift+Enter и цифра с модификатором — не ответ', () => {
    const on = ctx({ pendingQuestion: true })
    expect(resolveComposerKey(key({ key: '0', code: 'Digit0' }), on)).toBe('insert')
    expect(resolveComposerKey(key({ key: 'Enter', shiftKey: true }), on)).toBe('newline')
    expect(resolveComposerKey(key({ key: '2', code: 'Digit2', ctrlKey: true }), on)).toBe('insert')
  })

  test('поле ввода чата вопроса не знает: цифра и Enter — его', () => {
    expect(resolveComposerKey(key({ key: '1', code: 'Digit1' }), ctx({ text: 'а' }))).toBe('insert')
    expect(resolveComposerKey(key({ key: 'Enter' }), ctx({ text: '12' }))).toBe('submit')
    expect(
      resolveComposerKey(key({ key: '1', code: 'Digit1' }), ctx({ text: 'а', pendingQuestion: true }))
    ).toBe('insert')
  })
})

describe('открытый план', () => {
  test('1 и Enter одобряют, 2 — отклонить, 3 — править', () => {
    const on = ctx({ pendingPlan: true })
    expect(resolveComposerKey(key({ key: '1', code: 'Digit1' }), on)).toBe('planApprove')
    expect(resolveComposerKey(key({ key: 'Enter' }), on)).toBe('planApprove')
    expect(resolveComposerKey(key({ key: '2', code: 'Digit2' }), on)).toBe('planReject')
    expect(resolveComposerKey(key({ key: '3', code: 'Numpad3' }), on)).toBe('planEdit')
  })

  test('4, Shift+Enter и цифра с модификатором — не ответ', () => {
    const on = ctx({ pendingPlan: true })
    expect(resolveComposerKey(key({ key: '4', code: 'Digit4' }), on)).toBe('insert')
    expect(resolveComposerKey(key({ key: 'Enter', shiftKey: true }), on)).toBe('newline')
    expect(resolveComposerKey(key({ key: '1', code: 'Digit1', ctrlKey: true }), on)).toBe('insert')
  })

  test('поле ввода чата плана не знает: цифра и Enter — его', () => {
    expect(
      resolveComposerKey(key({ key: '1', code: 'Digit1' }), ctx({ text: 'а', pendingPlan: true }))
    ).toBe('insert')
    expect(resolveComposerKey(key({ key: 'Enter' }), ctx({ text: 'а', pendingPlan: true }))).toBe('submit')
  })
})
