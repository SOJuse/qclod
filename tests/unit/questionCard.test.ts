// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QuestionCard } from '../../src/renderer/components/cards/QuestionCard'
import type { QuestionItem } from '../../src/renderer/components/cards/types'
import type { CardAnswers } from '../../src/renderer/chat/cardAnswers'
import { ARM_MS } from '../../src/renderer/chat/permissionKeyGuard'
import type { QuestionView } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const q = (question: string, labels: string[], extra: Partial<QuestionView> = {}): QuestionView => ({
  question,
  header: `Тема ${question}`,
  options: labels.map((label) => ({ label, description: `про ${label}` })),
  multiSelect: false,
  ...extra
})

const THREE = [
  q('Где панель?', ['Слева', 'Справа (Recommended)']),
  q('Какие цвета?', ['Синий', 'Красный', 'Зелёный'], { multiSelect: true }),
  q('Когда?', ['Сейчас', 'Потом'])
]

const item = (questions: QuestionView[], patch: Partial<QuestionItem> = {}): QuestionItem => ({
  id: 'q1',
  kind: 'question',
  toolUseId: 'tu-1',
  questions,
  answers: null,
  ...patch
})

function fakeAnswers(): CardAnswers & { question: ReturnType<typeof vi.fn> } {
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
function mount(answers: CardAnswers, questions: QuestionView[] = THREE): void {
  act(() => {
    root.render(
      createElement(
        'section',
        { 'data-testid': 'chat-pane', className: 'chat-pane is-focused' },
        createElement(QuestionCard, { item: item(questions), answers, focused: true }),
        createElement('textarea', { 'data-composer-input': '' })
      )
    )
  })
}

const card = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="question-card"]')!
const own = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>('[data-testid="question-own"]')!
const options = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="question-option"]')]
const byId = (id: string): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
const progress = (): string | null | undefined => host.querySelector('[data-testid="question-progress"]')?.textContent

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

describe('QuestionCard', () => {
  test('три вопроса показываются по одному, «Вопрос 1 из 3»', () => {
    mount(fakeAnswers())
    expect(progress()).toBe('Вопрос 1 из 3')
    expect(card().textContent).toContain('Тема Где панель?')
    expect(card().textContent).toContain('Где панель?')
    expect(card().textContent).not.toContain('Какие цвета?')
    expect(options()).toHaveLength(2)
    expect(byId('question-back')).toBeNull()
    expect(byId('question-next')?.textContent).toContain('Дальше')
    expect(byId('question-submit')).toBeNull()
  })

  test('один вопрос — без счётчика шагов, сразу «Ответить»', () => {
    mount(fakeAnswers(), [THREE[0]!])
    expect(progress()).toBeUndefined()
    expect(byId('question-next')).toBeNull()
    expect(byId('question-submit')?.textContent).toContain('Ответить')
  })

  test('варианты с номерами, описанием и бейджем «рекомендуется» без суффикса', () => {
    mount(fakeAnswers())
    const [first, second] = options()
    expect(first!.textContent).toContain('1.')
    expect(first!.textContent).toContain('Слева')
    expect(first!.textContent).toContain('про Слева')
    expect(first!.textContent).not.toContain('рекомендуется')
    expect(second!.textContent).toContain('2.')
    expect(second!.textContent).toContain('рекомендуется')
    expect(second!.querySelector('.question-card-label')!.textContent).toBe('Справарекомендуется')
    expect(first!.getAttribute('aria-pressed')).toBe('false')
    expect(card().textContent).not.toContain('можно несколько')
  })

  test('2, затем Enter — шаг 2', () => {
    mount(fakeAnswers())
    focusAndArm()
    press(card(), '2', 'Digit2')
    expect(options()[1]!.getAttribute('aria-pressed')).toBe('true')
    press(card(), 'Enter', 'Enter')
    expect(progress()).toBe('Вопрос 2 из 3')
    expect(card().textContent).toContain('Какие цвета?')
    expect(card().textContent).toContain('можно несколько')
    expect(document.activeElement).toBe(card())
  })

  test('Enter без ответа не идёт дальше; «Дальше» неактивна', () => {
    mount(fakeAnswers())
    focusAndArm()
    expect(byId('question-next')!.disabled).toBe(true)
    press(card(), 'Enter', 'Enter')
    expect(progress()).toBe('Вопрос 1 из 3')
  })

  test('на последнем Enter вызывает answers.question один раз со всеми тремя ответами', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '2', 'Digit2')
    press(card(), 'Enter', 'Enter')
    // Multi-choice: 3, then 1 — sent in the options' order.
    press(card(), '3', 'Digit3')
    press(card(), '1', 'Digit1')
    press(card(), 'Enter', 'Enter')
    expect(progress()).toBe('Вопрос 3 из 3')
    expect(byId('question-submit')).not.toBeNull()
    press(card(), '1', 'Digit1')
    expect(answers.question).not.toHaveBeenCalled()
    press(card(), 'Enter', 'Enter')
    press(card(), 'Enter', 'Enter')
    expect(answers.question).toHaveBeenCalledTimes(1)
    expect(answers.question).toHaveBeenCalledWith(
      'tu-1',
      { 'Где панель?': 'Справа (Recommended)', 'Какие цвета?': 'Синий, Зелёный', 'Когда?': 'Сейчас' },
      {}
    )
    // Answered: focus goes back to the input line.
    expect(document.activeElement).toBe(host.querySelector('[data-composer-input]'))
  })

  test('placeholder меняется после выбора', () => {
    mount(fakeAnswers())
    focusAndArm()
    expect(own().placeholder).toBe('Свой ответ…')
    press(card(), '2', 'Digit2')
    expect(own().placeholder).toBe('Комментарий к «Справа» (необязательно)')
    press(card(), 'Enter', 'Enter')
    press(card(), '1', 'Digit1')
    expect(own().placeholder).toBe('Комментарий к «Синий» (необязательно)')
    press(card(), '2', 'Digit2')
    expect(own().placeholder).toBe('Комментарий (необязательно)')
  })

  test('цифра в question-own не выбирает вариант', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    act(() => own().focus())
    for (const [key, code] of [['1', 'Digit1'], ['2', 'Digit2']] as const) {
      const ev = press(own(), key, code)
      expect(ev.defaultPrevented).toBe(false)
    }
    expect(options().map((o) => o.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    expect(answers.question).not.toHaveBeenCalled()
  })

  test('«Назад» сохраняет выбор первого шага', () => {
    mount(fakeAnswers())
    focusAndArm()
    press(card(), '1', 'Digit1')
    typeInto(own(), 'поближе к краю')
    act(() => byId('question-next')!.click())
    expect(progress()).toBe('Вопрос 2 из 3')
    expect(own().value).toBe('')
    act(() => byId('question-back')!.click())
    expect(progress()).toBe('Вопрос 1 из 3')
    expect(options()[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(own().value).toBe('поближе к краю')
  })

  test('клик по варианту одиночного вопроса только выбирает, отвечает «Ответить» (П17)', () => {
    const answers = fakeAnswers()
    mount(answers, [THREE[0]!])
    act(() => options()[0]!.click())
    expect(answers.question).not.toHaveBeenCalled()
    expect(options()[0]!.getAttribute('aria-pressed')).toBe('true')
    act(() => options()[1]!.click())
    expect(options().map((o) => o.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    act(() => byId('question-submit')!.click())
    expect(answers.question).toHaveBeenCalledWith('tu-1', { 'Где панель?': 'Справа (Recommended)' }, {})
  })

  test('Enter на кнопке варианта — дальше, а не повторный выбор', () => {
    const answers = fakeAnswers()
    mount(answers, [THREE[0]!])
    focusAndArm()
    act(() => options()[0]!.focus())
    act(() => options()[0]!.click())
    const ev = press(options()[0]!, 'Enter', 'Enter')
    expect(ev.defaultPrevented).toBe(true)
    expect(answers.question).toHaveBeenCalledWith('tu-1', { 'Где панель?': 'Слева' }, {})
  })

  test('вариант и комментарий: Enter в поле отправляет, текст — в notes', () => {
    const answers = fakeAnswers()
    mount(answers, [THREE[0]!])
    act(() => options()[0]!.click())
    act(() => own().focus())
    typeInto(own(), '  но узкую  ')
    press(own(), 'Enter', 'Enter')
    expect(answers.question).toHaveBeenCalledTimes(1)
    expect(answers.question).toHaveBeenCalledWith('tu-1', { 'Где панель?': 'Слева' }, { 'Где панель?': 'но узкую' })
  })

  test('свой ответ без выбора: Enter в поле отправляет его ответом', () => {
    const answers = fakeAnswers()
    mount(answers, [THREE[0]!])
    act(() => own().focus())
    typeInto(own(), 'посередине')
    press(own(), 'Enter', 'Enter')
    expect(answers.question).toHaveBeenCalledWith('tu-1', { 'Где панель?': 'посередине' }, {})
  })

  test('Shift+Enter в поле — перенос строки, не отправка; пустое поле Enter не отправляет', () => {
    const answers = fakeAnswers()
    mount(answers, [THREE[0]!])
    act(() => own().focus())
    press(own(), 'Enter', 'Enter')
    typeInto(own(), 'строка')
    const ev = press(own(), 'Enter', 'Enter', { shiftKey: true })
    expect(ev.defaultPrevented).toBe(false)
    expect(answers.question).not.toHaveBeenCalled()
  })

  test('Enter в поле на первом из трёх — следующий шаг, фокус остаётся в поле', () => {
    mount(fakeAnswers())
    act(() => own().focus())
    typeInto(own(), 'сверху')
    press(own(), 'Enter', 'Enter')
    expect(progress()).toBe('Вопрос 2 из 3')
    expect(document.activeElement).toBe(own())
    expect(own().value).toBe('')
  })

  test('Esc в поле — фокус на карточку', () => {
    mount(fakeAnswers())
    act(() => own().focus())
    const ev = press(own(), 'Escape', 'Escape')
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(card())
  })

  test('цифры в первые 400 мс после фокуса, с Ctrl и повтором не выбирают', () => {
    mount(fakeAnswers())
    act(() => card().focus())
    press(card(), '1', 'Digit1')
    now += ARM_MS + 100
    press(card(), '1', 'Digit1', { ctrlKey: true })
    press(card(), '2', 'Digit2', { repeat: true })
    expect(options().map((o) => o.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
  })

  test('цифра без такого варианта ничего не делает', () => {
    mount(fakeAnswers())
    focusAndArm()
    const ev = press(card(), '7', 'Digit7')
    expect(ev.defaultPrevented).toBe(false)
    expect(options().map((o) => o.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
  })

  test('поле — до 2000 знаков, у предела виден счётчик', () => {
    mount(fakeAnswers())
    expect(own().maxLength).toBe(2000)
    expect(byId('question-own-count')).toBeNull()
    typeInto(own(), 'я'.repeat(1900))
    expect(host.querySelector('[data-testid="question-own-count"]')?.textContent).toBe('1900 / 2000')
  })
})
