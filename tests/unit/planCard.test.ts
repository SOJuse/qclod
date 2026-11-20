// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PlanCard } from '../../src/renderer/components/cards/PlanCard'
import type { PlanItem } from '../../src/renderer/components/cards/types'
import type { CardAnswers } from '../../src/renderer/chat/cardAnswers'
import { ARM_MS } from '../../src/renderer/chat/permissionKeyGuard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PLAN = '## План\n\n1. Разобрать модуль на три части\n2. Перенести тесты'

const item = (patch: Partial<PlanItem> = {}): PlanItem => ({
  id: 'l1',
  kind: 'plan',
  requestId: 'r1',
  text: PLAN,
  state: 'pending',
  ...patch
})

function fakeAnswers(): CardAnswers & { plan: ReturnType<typeof vi.fn> } {
  return { permission: vi.fn(), question: vi.fn(), plan: vi.fn() }
}

let now = 10_000
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  now = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

/** The card inside a focused pane, next to an input line, as ChatPane draws it. */
function mount(answers: CardAnswers, patch: Partial<PlanItem> = {}): void {
  act(() => {
    root.render(
      createElement(
        'section',
        { 'data-testid': 'chat-pane', className: 'chat-pane is-focused' },
        createElement(PlanCard, { item: item(patch), answers }),
        createElement('textarea', { 'data-composer-input': '' })
      )
    )
  })
}

const card = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="plan-card"]')!
const byId = <T extends HTMLElement = HTMLButtonElement>(id: string): T | null =>
  host.querySelector<T>(`[data-testid="${id}"]`)
const comment = (): HTMLTextAreaElement | null => byId<HTMLTextAreaElement>('plan-comment')
const editor = (): HTMLTextAreaElement | null => byId<HTMLTextAreaElement>('plan-editor')

/** Focus comes to the card from outside, and its keys arm. */
function focusAndArm(): void {
  act(() => card().focus())
  now += ARM_MS + 100
}

function press(target: Element, key: string, code: string, extra: KeyboardEventInit = {}): KeyboardEvent {
  const down = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...extra })
  act(() => {
    target.dispatchEvent(down)
  })
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true }))
  })
  return down
}

/** Types into a React-controlled field: the value the way the browser sets it, then the event React listens to. */
function typeInto(field: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('PlanCard', () => {
  test('текст плана — разметкой, три кнопки с цифрами', () => {
    mount(fakeAnswers())
    const text = byId<HTMLElement>('plan-text')!
    expect(text.querySelector('.md')).not.toBeNull()
    expect(text.querySelector('.md-h')?.textContent).toBe('План')
    expect(text.textContent).toContain('Разобрать модуль на три части')
    const kbd = (id: string): string | undefined => byId(id)?.querySelector('kbd')?.textContent ?? undefined
    expect(byId('plan-approve')?.textContent).toContain('Одобрить')
    expect(kbd('plan-approve')).toBe('1')
    expect(byId('plan-reject')?.textContent).toContain('Отклонить')
    expect(kbd('plan-reject')).toBe('2')
    expect(byId('plan-edit')?.textContent).toContain('Править')
    expect(kbd('plan-edit')).toBe('3')
    expect(comment()).toBeNull()
    expect(editor()).toBeNull()
  })

  test('1 одобряет', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '1', 'Digit1')
    expect(answers.plan).toHaveBeenCalledTimes(1)
    expect(answers.plan).toHaveBeenCalledWith('r1', { approve: true })
    // Focus goes back to the input line of its own pane.
    expect(document.activeElement).toBe(host.querySelector('[data-composer-input]'))
  })

  test('Enter и «Одобрить» тоже одобряют, ответ уходит один раз', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), 'Enter', 'Enter')
    act(() => byId('plan-approve')!.click())
    expect(answers.plan).toHaveBeenCalledTimes(1)
    expect(answers.plan).toHaveBeenCalledWith('r1', { approve: true })
  })

  test('отклонить с комментарием', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '2', 'Digit2')
    expect(answers.plan).not.toHaveBeenCalled()
    const field = comment()!
    expect(document.activeElement).toBe(field)
    expect(field.placeholder).toBe('Что изменить в плане? (необязательно)')
    expect(field.maxLength).toBe(4000)
    expect(byId('plan-reject-send')?.textContent).toContain('Отклонить')

    typeInto(field, 'сначала тесты')
    press(field, 'Enter', 'Enter')
    expect(answers.plan).toHaveBeenCalledTimes(1)
    expect(answers.plan).toHaveBeenCalledWith('r1', { approve: false, comment: 'сначала тесты' })
  })

  test('«Отклонить» открывает поле, «Отклонить» рядом с ним отправляет; пустое — без комментария', () => {
    const answers = fakeAnswers()
    mount(answers)
    act(() => byId('plan-reject')!.click())
    expect(answers.plan).not.toHaveBeenCalled()
    expect(byId('plan-reject')!.getAttribute('aria-expanded')).toBe('true')
    typeInto(comment()!, '   ')
    act(() => byId('plan-reject-send')!.click())
    expect(answers.plan).toHaveBeenCalledWith('r1', { approve: false })
  })

  test('в поле комментария цифры — текст; Shift+Enter — перенос; Esc закрывает поле', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '2', 'Digit2')
    const field = comment()!
    for (const [key, code] of [['1', 'Digit1'], ['2', 'Digit2'], ['3', 'Digit3']] as const) {
      expect(press(field, key, code).defaultPrevented).toBe(false)
    }
    expect(press(field, 'Enter', 'Enter', { shiftKey: true }).defaultPrevented).toBe(false)
    press(field, 'Escape', 'Escape')
    expect(comment()).toBeNull()
    expect(document.activeElement).toBe(card())
    expect(answers.plan).not.toHaveBeenCalled()
  })

  test('пока поле комментария открыто, цифры на кнопках не отвечают, Enter на кнопке — отказ с комментарием', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '2', 'Digit2')
    typeInto(comment()!, 'сначала тесты')
    const approve = byId('plan-approve')!
    act(() => approve.focus())
    press(approve, '1', 'Digit1')
    press(approve, '3', 'Digit3')
    press(card(), '1', 'Digit1')
    expect(answers.plan).not.toHaveBeenCalled()
    expect(editor()).toBeNull()

    expect(press(approve, 'Enter', 'Enter').defaultPrevented).toBe(true)
    expect(answers.plan).toHaveBeenCalledTimes(1)
    expect(answers.plan).toHaveBeenCalledWith('r1', { approve: false, comment: 'сначала тесты' })
  })

  test('удержанная «2» не печатает свой повтор в поле комментария', () => {
    mount(fakeAnswers())
    focusAndArm()
    act(() => {
      card().dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', bubbles: true, cancelable: true }))
    })
    const field = comment()!
    expect(document.activeElement).toBe(field)
    const again = new KeyboardEvent('keydown', { key: '2', code: 'Digit2', repeat: true, bubbles: true, cancelable: true })
    act(() => {
      field.dispatchEvent(again)
    })
    expect(again.defaultPrevented).toBe(true)
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keyup', { key: '2', code: 'Digit2', bubbles: true, cancelable: true }))
    })
    expect(press(field, '2', 'Digit2').defaultPrevented).toBe(false)
  })

  test('3 открывает редактор с текстом плана', () => {
    mount(fakeAnswers())
    focusAndArm()
    press(card(), '3', 'Digit3')
    const field = editor()!
    expect(field.value).toBe(PLAN)
    expect(field.maxLength).toBe(100_000)
    expect(document.activeElement).toBe(field)
    expect(byId('plan-approve-edited')?.textContent).toContain('Одобрить с правками')
    expect(byId('plan-edit-cancel')?.textContent).toContain('Отмена')
    // While editing, the plan's own buttons are gone: «Одобрить с правками» and «Отмена» are the way out.
    expect(byId('plan-approve')).toBeNull()
  })

  test('правка: пустая или та же — кнопка неактивна', () => {
    mount(fakeAnswers())
    act(() => byId('plan-edit')!.click())
    const send = (): HTMLButtonElement => byId('plan-approve-edited')!
    expect(send().disabled).toBe(true)
    typeInto(editor()!, '   \n ')
    expect(send().disabled).toBe(true)
    typeInto(editor()!, `${PLAN}\n3. Прогнать тесты`)
    expect(send().disabled).toBe(false)
    typeInto(editor()!, PLAN)
    expect(send().disabled).toBe(true)
  })

  test('Ctrl+Enter в редакторе отправляет правку', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '3', 'Digit3')
    const edited = `${PLAN}\n3. Прогнать тесты`
    // A plain Enter is a line break, nothing is sent.
    expect(press(editor()!, 'Enter', 'Enter').defaultPrevented).toBe(false)
    typeInto(editor()!, edited)
    press(editor()!, 'Enter', 'Enter', { ctrlKey: true })
    expect(answers.plan).toHaveBeenCalledTimes(1)
    expect(answers.plan).toHaveBeenCalledWith('r1', { approve: true, plan: edited })
  })

  test('Ctrl+Enter без правки ничего не отправляет; «Одобрить с правками» — отправляет', () => {
    const answers = fakeAnswers()
    mount(answers)
    act(() => byId('plan-edit')!.click())
    press(editor()!, 'Enter', 'Enter', { ctrlKey: true })
    expect(answers.plan).not.toHaveBeenCalled()
    typeInto(editor()!, '1. Только тесты')
    act(() => byId('plan-approve-edited')!.click())
    expect(answers.plan).toHaveBeenCalledWith('r1', { approve: true, plan: '1. Только тесты' })
  })

  test('Esc в редакторе возвращает к кнопкам', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '3', 'Digit3')
    typeInto(editor()!, '1. Другое')
    expect(press(editor()!, 'Escape', 'Escape').defaultPrevented).toBe(true)
    expect(editor()).toBeNull()
    expect(byId('plan-approve')).not.toBeNull()
    expect(byId<HTMLElement>('plan-text')!.textContent).toContain('Разобрать модуль на три части')
    expect(document.activeElement).toBe(card())
    expect(answers.plan).not.toHaveBeenCalled()
    // The edit was cancelled: opened again, the editor has the plan as it was.
    act(() => byId('plan-edit')!.click())
    expect(editor()!.value).toBe(PLAN)
  })

  test('«Отмена» тоже возвращает к кнопкам', () => {
    mount(fakeAnswers())
    act(() => byId('plan-edit')!.click())
    act(() => byId('plan-edit-cancel')!.click())
    expect(editor()).toBeNull()
    expect(byId('plan-approve')).not.toBeNull()
  })

  test('цифры в редакторе — текст', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '3', 'Digit3')
    for (const [key, code] of [['1', 'Digit1'], ['2', 'Digit2'], ['3', 'Digit3']] as const) {
      expect(press(editor()!, key, code).defaultPrevented).toBe(false)
    }
    expect(answers.plan).not.toHaveBeenCalled()
    expect(editor()).not.toBeNull()
  })

  test('повтор клавиши, ранняя цифра и цифра с Ctrl не отвечают', () => {
    const answers = fakeAnswers()
    mount(answers)
    act(() => card().focus())
    press(card(), '1', 'Digit1')
    now += ARM_MS + 100
    press(card(), '1', 'Digit1', { repeat: true })
    press(card(), '1', 'Digit1', { ctrlKey: true })
    press(card(), '4', 'Digit4')
    expect(answers.plan).not.toHaveBeenCalled()
    expect(comment()).toBeNull()
  })

  test('у длинного комментария и длинной правки виден счётчик до предела', () => {
    mount(fakeAnswers())
    act(() => byId('plan-reject')!.click())
    expect(byId('plan-comment-count')).toBeNull()
    typeInto(comment()!, 'я'.repeat(3600))
    expect(byId('plan-comment-count')?.textContent).toBe('3600 / 4000')

    act(() => byId('plan-edit')!.click())
    expect(byId('plan-editor-count')).toBeNull()
    typeInto(editor()!, 'я'.repeat(95_000))
    expect(byId('plan-editor-count')?.textContent).toBe('95000 / 100000')
  })

  test('правка длиннее предела не отправляется', () => {
    const answers = fakeAnswers()
    mount(answers)
    act(() => byId('plan-edit')!.click())
    typeInto(editor()!, 'я'.repeat(100_001))
    expect(byId<HTMLButtonElement>('plan-approve-edited')!.disabled).toBe(true)
    press(editor()!, 'Enter', 'Enter', { ctrlKey: true })
    expect(answers.plan).not.toHaveBeenCalled()
  })
})
