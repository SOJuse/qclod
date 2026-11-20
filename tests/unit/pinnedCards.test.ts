// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PinnedCards } from '../../src/renderer/components/cards/PinnedCards'
import { formatCountdown } from '../../src/renderer/components/cards/PinnedCard'
import type { AutoAnswerView, OpenCard } from '../../src/renderer/components/cards/types'
import type { CardAnswers } from '../../src/renderer/chat/cardAnswers'
import { ARM_MS, FOCUS_BEFORE_MS } from '../../src/renderer/chat/permissionKeyGuard'
import type { RibbonItem } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const perm = (id: string, target: string, extra: Partial<Extract<RibbonItem, { kind: 'permission' }>> = {}): RibbonItem => ({
  id,
  kind: 'permission',
  requestId: `req-${id}`,
  toolName: 'Bash',
  target,
  state: 'pending',
  ...extra
})
const explore: RibbonItem = {
  id: 'sa',
  kind: 'subagent',
  toolUseId: 'tu-sa',
  name: 'Explore',
  task: 'найти вход',
  state: 'running',
  summary: ''
}

function fakeAnswers(): CardAnswers & { permission: ReturnType<typeof vi.fn> } {
  return { permission: vi.fn(), question: vi.fn(), plan: vi.fn() }
}

let now = 50_000
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

interface Options {
  answers?: CardAnswers
  autoAnswerFor?: (card: OpenCard) => AutoAnswerView | undefined
}

/** The strip in a focused pane, above an input line, as ChatPane draws it. */
function render(items: RibbonItem[], { answers = fakeAnswers(), autoAnswerFor }: Options = {}): void {
  act(() => {
    root.render(
      createElement(
        'section',
        { 'data-testid': 'chat-pane', className: 'chat-pane is-focused' },
        createElement('div', { 'data-testid': 'ribbon', tabIndex: -1 }),
        createElement(PinnedCards, {
          tabId: 't1',
          items,
          answers,
          ...(autoAnswerFor ? { autoAnswerFor } : {})
        }),
        createElement('textarea', { 'data-composer-input': '', defaultValue: '' })
      )
    )
  })
}

const pinned = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="pinned-card"]')]
const input = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>('[data-composer-input]')!

function press(target: Element, key: string, code: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }))
    target.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true }))
  })
}

/** Runs the timer a card asks for focus from, after the commit's other effects. */
function afterEffects(): void {
  act(() => {
    vi.runOnlyPendingTimers()
  })
}

describe('PinnedCards', () => {
  test('одна карточка за раз, старшая первой', () => {
    render([perm('a', 'первый'), perm('b', 'второй')])
    expect(pinned()).toHaveLength(1)
    expect(pinned()[0]!.dataset.kind).toBe('permission')
    expect(pinned()[0]!.textContent).toContain('Разрешение')
    expect(pinned()[0]!.textContent).toContain('первый')
    expect(host.textContent).not.toContain('второй')
  })

  test('отвеченная карточка уходит, на её место встаёт следующая', () => {
    render([perm('a', 'первый', { state: 'allowed' }), perm('b', 'второй')])
    expect(pinned()).toHaveLength(1)
    expect(pinned()[0]!.textContent).toContain('второй')
  })

  test('нет открытых — плашки нет', () => {
    render([perm('a', 'первый', { state: 'denied' })])
    expect(host.querySelector('[data-testid="pinned-cards"]')).toBeNull()
  })

  test('счётчик ещё ждущих', () => {
    render([perm('a', '1'), perm('b', '2'), perm('c', '3')])
    expect(host.querySelector('[data-testid="pinned-more"]')?.textContent).toBe('Ещё 2 ждут ответа')
    render([perm('a', '1'), perm('b', '2')])
    expect(host.querySelector('[data-testid="pinned-more"]')?.textContent).toBe('Ещё 1 ждёт ответа')
    render([perm('a', '1')])
    expect(host.querySelector('[data-testid="pinned-more"]')).toBeNull()
  })

  test('карточка сабагента подписана', () => {
    render([explore, perm('p', 'src', { parentId: 'sa' })])
    expect(pinned()[0]!.textContent).toContain('Разрешение · от агента Explore')
  })

  test('карточка верхнего уровня без подписи', () => {
    render([perm('p', 'src')])
    expect(pinned()[0]!.textContent).not.toContain('от агента')
  })

  test('autoAnswer рисует отсчёт', () => {
    const onAnswerNow = vi.fn()
    const onStop = vi.fn()
    const seen: OpenCard[] = []
    render([perm('p', 'src')], {
      autoAnswerFor: (card) => {
        seen.push(card)
        return { deadline: Date.now() + 299_500, label: 'Отвечу сам', onAnswerNow, onStop }
      }
    })
    expect(seen[0]).toMatchObject({ kind: 'permission', requestId: 'req-p' })
    const strip = host.querySelector('[data-testid="auto-answer"]')!
    expect(strip.textContent).toContain('Отвечу сам через 4:59')
    const now = host.querySelector<HTMLButtonElement>('[data-testid="auto-answer-now"]')!
    const stop = host.querySelector<HTMLButtonElement>('[data-testid="auto-answer-stop"]')!
    expect(now.textContent).toContain('Ответить сейчас')
    expect(stop.textContent).toContain('Остановить таймер')
    act(() => now.click())
    act(() => stop.click())
    expect(onAnswerNow).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  test('без autoAnswer полоски отсчёта нет', () => {
    render([perm('p', 'src')], { autoAnswerFor: () => undefined })
    expect(host.querySelector('[data-testid="auto-answer"]')).toBeNull()
    render([perm('p', 'src')])
    expect(host.querySelector('[data-testid="auto-answer"]')).toBeNull()
  })

  test('отсчёт идёт раз в секунду', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    render([perm('p', 'src')], {
      autoAnswerFor: () => ({ deadline: Date.now() + 65_000, label: 'Разрешу', onAnswerNow() {}, onStop() {} })
    })
    expect(host.querySelector('[data-testid="auto-answer"]')!.textContent).toContain('Разрешу через 1:05')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(host.querySelector('[data-testid="auto-answer"]')!.textContent).toContain('Разрешу через 1:04')
  })
})

describe('formatCountdown', () => {
  test('минуты и секунды с нулём впереди', () => {
    expect(formatCountdown(65_000)).toBe('1:05')
    expect(formatCountdown(299_500)).toBe('4:59')
    expect(formatCountdown(5_000)).toBe('0:05')
  })

  test('меньше нуля — 0:00', () => {
    expect(formatCountdown(-5)).toBe('0:00')
    expect(formatCountdown(0)).toBe('0:00')
  })
})

// Review Focus 3: two cards open at once while the person is typing.
describe('две открытые карточки, человек печатает в поле ввода', () => {
  /** The window has been in front for a while before anything was asked. */
  function windowInFront(): void {
    now -= FOCUS_BEFORE_MS * 5
    window.dispatchEvent(new Event('focus'))
    now += FOCUS_BEFORE_MS * 5
  }

  function startTyping(text: string): void {
    act(() => input().focus())
    input().value = text
  }

  test('цифры и Enter в поле ввода не отвечают карточке; после ответа первой фокус остаётся в поле', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    windowInFront()
    const answers = fakeAnswers()
    const first = perm('rf1', 'первый')
    const second = perm('rf2', 'второй')
    render([], { answers })
    startTyping('12')
    render([first, second], { answers })
    afterEffects()
    now += ARM_MS + 100
    // A draft is where the person is: the first card shows and leaves focus alone.
    expect(document.activeElement).toBe(input())

    for (const [key, code] of [['1', 'Digit1'], ['2', 'Digit2'], ['3', 'Digit3'], ['4', 'Digit4'], ['Enter', 'Enter'], ['Escape', 'Escape']] as const) {
      press(input(), key, code)
    }
    expect(answers.permission).not.toHaveBeenCalled()
    expect(answers.question).not.toHaveBeenCalled()
    expect(answers.plan).not.toHaveBeenCalled()

    // The first is answered with a click; focus never left the field.
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="permission-allow"]')!.click())
    expect(answers.permission).toHaveBeenCalledTimes(1)
    expect(answers.permission).toHaveBeenCalledWith('req-rf1', { behavior: 'allow', scope: 'once' })

    // The strip shows the next one, and it does not take focus from the draft.
    now += FOCUS_BEFORE_MS * 2
    render([{ ...first, state: 'allowed' } as RibbonItem, second], { answers })
    afterEffects()
    expect(pinned()[0]!.textContent).toContain('второй')
    expect(document.activeElement).toBe(input())
    press(input(), '1', 'Digit1')
    press(input(), 'Enter', 'Enter')
    expect(answers.permission).toHaveBeenCalledTimes(1)
  })

  test('с пустым полем следующая карточка берёт фокус (без этого тест выше ничего не доказывает)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    windowInFront()
    const first = perm('re1', 'первый')
    const second = perm('re2', 'второй')
    render([])
    startTyping('')
    render([first, second])
    afterEffects()
    expect(document.activeElement).toBe(host.querySelector('[data-testid="permission-card"]'))

    act(() => input().focus())
    now += FOCUS_BEFORE_MS * 2
    render([{ ...first, state: 'allowed' } as RibbonItem, second])
    afterEffects()
    const card = host.querySelector('[data-testid="permission-card"]')!
    expect(card.textContent).toContain('второй')
    expect(document.activeElement).toBe(card)
  })
})

const ask = (id: string, question: string): RibbonItem => ({
  id,
  kind: 'question',
  toolUseId: `tu-${id}`,
  questions: [
    { question, header: 'Тема', options: [{ label: 'Да', description: '' }, { label: 'Нет', description: '' }], multiSelect: false }
  ],
  answers: null
})

describe('вопрос в плашке', () => {
  test('открытый вопрос закреплён над полем ввода: «Вопрос» и карточка вопроса', () => {
    render([ask('q', 'Продолжать?')])
    expect(pinned()).toHaveLength(1)
    expect(pinned()[0]!.dataset.kind).toBe('question')
    expect(pinned()[0]!.querySelector('header')!.textContent).toBe('Вопрос')
    expect(pinned()[0]!.querySelector('[data-testid="question-card"]')!.textContent).toContain('Продолжать?')
  })

  test('вопрос и разрешение — по очереди ленты', () => {
    render([ask('q', 'Продолжать?'), perm('p', 'npm test')])
    expect(pinned()[0]!.dataset.kind).toBe('question')
    expect(host.querySelector('[data-testid="pinned-more"]')?.textContent).toBe('Ещё 1 ждёт ответа')
  })

  test('autoAnswer показывается и у вопроса', () => {
    render([ask('q', 'Продолжать?')], {
      autoAnswerFor: (card) =>
        card.kind === 'question'
          ? { deadline: Date.now() + 65_000, label: 'Отвечу «Да»', onAnswerNow() {}, onStop() {} }
          : undefined
    })
    expect(host.querySelector('[data-testid="auto-answer"]')?.textContent).toContain('Отвечу «Да» через')
  })
})

// Review Focus 3 for a question: the same as for a permission.
describe('открытый вопрос, человек печатает в поле ввода', () => {
  function windowInFront(): void {
    now -= FOCUS_BEFORE_MS * 5
    window.dispatchEvent(new Event('focus'))
    now += FOCUS_BEFORE_MS * 5
  }

  test('цифры и Enter в непустом поле ввода не отвечают вопросу, плашка не крадёт фокус', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    windowInFront()
    const answers = fakeAnswers()
    const first = perm('rq1', 'первый')
    const second = ask('rq2', 'Продолжать?')
    render([], { answers })
    act(() => input().focus())
    input().value = '12'
    render([first, second], { answers })
    afterEffects()
    now += ARM_MS + 100
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="permission-allow"]')!.click())

    now += FOCUS_BEFORE_MS * 2
    render([{ ...first, state: 'allowed' } as RibbonItem, second], { answers })
    afterEffects()
    expect(pinned()[0]!.dataset.kind).toBe('question')
    expect(document.activeElement).toBe(input())
    now += ARM_MS + 100
    for (const [key, code] of [['1', 'Digit1'], ['2', 'Digit2'], ['Enter', 'Enter'], ['Escape', 'Escape']] as const) {
      press(input(), key, code)
    }
    expect(answers.question).not.toHaveBeenCalled()
    const options = [...host.querySelectorAll('[data-testid="question-option"]')]
    expect(options.map((o) => o.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    expect(document.activeElement).toBe(input())
  })

  test('с пустым полем вопрос берёт фокус, и его цифры работают (без этого тест выше ничего не доказывает)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    windowInFront()
    const answers = fakeAnswers()
    render([], { answers })
    act(() => input().focus())
    input().value = ''
    render([ask('rq3', 'Продолжать?')], { answers })
    afterEffects()
    const card = host.querySelector<HTMLElement>('[data-testid="question-card"]')!
    expect(document.activeElement).toBe(card)
    now += ARM_MS + 100
    press(card, '2', 'Digit2')
    press(card, 'Enter', 'Enter')
    expect(answers.question).toHaveBeenCalledWith('tu-rq3', { 'Продолжать?': 'Нет' }, {})
  })
})
