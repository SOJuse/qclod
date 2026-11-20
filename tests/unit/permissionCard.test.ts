// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PermissionCard } from '../../src/renderer/components/cards/PermissionCard'
import type { PermissionItem } from '../../src/renderer/components/cards/types'
import type { CardAnswers } from '../../src/renderer/chat/cardAnswers'
import { ARM_MS } from '../../src/renderer/chat/permissionKeyGuard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item = (patch: Partial<PermissionItem> = {}): PermissionItem => ({
  id: 'p1',
  kind: 'permission',
  requestId: 'r1',
  toolName: 'Bash',
  target: 'git push origin main',
  state: 'pending',
  ...patch
})

function fakeAnswers(): CardAnswers & { permission: ReturnType<typeof vi.fn> } {
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
function mount(answers: CardAnswers, patch: Partial<PermissionItem> = {}): void {
  act(() => {
    root.render(
      createElement(
        'section',
        { 'data-testid': 'chat-pane', className: 'chat-pane is-focused' },
        createElement(PermissionCard, { item: item(patch), answers, focused: true }),
        createElement('textarea', { 'data-composer-input': '' })
      )
    )
  })
}

const card = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="permission-card"]')!
const reasonField = (): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>('[data-testid="permission-deny-reason"]')

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
function typeInto(field: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('PermissionCard', () => {
  test('голова — инструмент и цель, четыре кнопки с цифрами', () => {
    mount(fakeAnswers())
    expect(card().textContent).toContain('Bash')
    expect(card().textContent).toContain('git push origin main')
    const kbd = (id: string): string | undefined =>
      host.querySelector(`[data-testid="${id}"] kbd`)?.textContent ?? undefined
    expect(host.querySelector('[data-testid="permission-allow"]')?.textContent).toContain('Разрешить')
    expect(kbd('permission-allow')).toBe('1')
    expect(host.querySelector('[data-testid="permission-allow-all"]')?.textContent).toContain('Разрешить всё такое')
    expect(kbd('permission-allow-all')).toBe('2')
    expect(host.querySelector('[data-testid="permission-allow-session"]')?.textContent).toContain(
      'Разрешить до конца сессии'
    )
    expect(kbd('permission-allow-session')).toBe('3')
    expect(host.querySelector('[data-testid="permission-deny"]')?.textContent).toContain('Запретить')
    expect(kbd('permission-deny')).toBe('4')
    expect(reasonField()).toBeNull()
  })

  test('1 и Enter разрешают один раз, 2 — всё такое', () => {
    for (const [key, code, scope] of [
      ['1', 'Digit1', 'once'],
      ['Enter', 'Enter', 'once'],
      ['2', 'Digit2', 'always']
    ] as const) {
      const answers = fakeAnswers()
      mount(answers, { requestId: `r-${code}` })
      focusAndArm()
      press(card(), key, code)
      expect(answers.permission).toHaveBeenCalledWith(`r-${code}`, { behavior: 'allow', scope })
      act(() => root.render(null))
    }
  })

  test('3 даёт разрешение до конца сессии', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '3', 'Digit3')
    expect(answers.permission).toHaveBeenCalledTimes(1)
    expect(answers.permission).toHaveBeenCalledWith('r1', { behavior: 'allow', scope: 'session' })
  })

  test('после ответа фокус уходит в поле ввода своей панели', () => {
    mount(fakeAnswers())
    focusAndArm()
    press(card(), '1', 'Digit1')
    expect(document.activeElement).toBe(host.querySelector('[data-composer-input]'))
  })

  test('4 открывает поле причины, Enter отправляет отказ с причиной', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '4', 'Digit4')
    expect(answers.permission).not.toHaveBeenCalled()
    const field = reasonField()!
    expect(field).not.toBeNull()
    expect(document.activeElement).toBe(field)
    expect(field.placeholder).toBe('Почему нет / что сделать вместо (необязательно)')
    expect(field.maxLength).toBe(2000)

    typeInto(field, 'не трогай main')
    press(field, 'Enter', 'Enter')
    expect(answers.permission).toHaveBeenCalledTimes(1)
    expect(answers.permission).toHaveBeenCalledWith('r1', { behavior: 'deny', reason: 'не трогай main' })
  })

  test('Esc на карточке тоже открывает поле причины, пустое Enter — отказ без причины', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), 'Escape', 'Escape')
    expect(answers.permission).not.toHaveBeenCalled()
    press(reasonField()!, 'Enter', 'Enter')
    expect(answers.permission).toHaveBeenCalledWith('r1', { behavior: 'deny' })
  })

  test('«Запретить» открывает поле, «Запретить» рядом с полем отправляет', () => {
    const answers = fakeAnswers()
    mount(answers)
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="permission-deny"]')!.click())
    expect(answers.permission).not.toHaveBeenCalled()
    typeInto(reasonField()!, 'сначала тесты')
    const send = host.querySelector<HTMLButtonElement>('[data-testid="permission-deny-send"]')!
    expect(send.textContent).toContain('Запретить')
    act(() => send.click())
    expect(answers.permission).toHaveBeenCalledWith('r1', { behavior: 'deny', reason: 'сначала тесты' })
  })

  test('Esc в пустом поле причины закрывает поле, ничего не отправлено', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '4', 'Digit4')
    press(reasonField()!, 'Escape', 'Escape')
    expect(reasonField()).toBeNull()
    expect(document.activeElement).toBe(card())
    expect(answers.permission).not.toHaveBeenCalled()
  })

  test('цифра в поле причины — текст, не ответ', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '4', 'Digit4')
    const field = reasonField()!
    for (const [key, code] of [['1', 'Digit1'], ['2', 'Digit2'], ['3', 'Digit3'], ['4', 'Digit4']] as const) {
      const ev = press(field, key, code)
      expect(ev.defaultPrevented).toBe(false)
    }
    expect(answers.permission).not.toHaveBeenCalled()
    expect(reasonField()).toBe(field)
  })

  test('повтор клавиши не отвечает', () => {
    const answers = fakeAnswers()
    mount(answers)
    focusAndArm()
    press(card(), '1', 'Digit1', { repeat: true })
    press(card(), '3', 'Digit3', { repeat: true })
    expect(answers.permission).not.toHaveBeenCalled()
  })

  test('цифра в первые 400 мс после фокуса и цифра с Ctrl не отвечают', () => {
    const answers = fakeAnswers()
    mount(answers)
    act(() => card().focus())
    press(card(), '1', 'Digit1')
    now += ARM_MS + 100
    press(card(), '2', 'Digit2', { ctrlKey: true })
    press(card(), '3', 'Digit3', { altKey: true })
    expect(answers.permission).not.toHaveBeenCalled()
  })

  test('у длинной причины виден счётчик до предела', () => {
    mount(fakeAnswers())
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="permission-deny"]')!.click())
    expect(host.querySelector('[data-testid="permission-deny-count"]')).toBeNull()
    typeInto(reasonField()!, 'я'.repeat(1900))
    expect(host.querySelector('[data-testid="permission-deny-count"]')?.textContent).toBe('1900 / 2000')
  })
})
