// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { autoAnswerTimer, toAutoAnswerView } from '../../src/renderer/chat/autoAnswer'
import { AutoAnswerGuard } from '../../src/renderer/components/cards/AutoAnswerGuard'
import { ARM_MS, trackHeldKeys } from '../../src/renderer/chat/permissionKeyGuard'
import { RibbonRow } from '../../src/renderer/components/RibbonItem'
import type { CardAnswers } from '../../src/renderer/chat/cardAnswers'
import type { AutonomyView, RibbonItem } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const view: AutonomyView = {
  timers: [
    { cardId: 'tu-1', kind: 'question', deadline: 90_000, label: 'Qclod выберет «Да»' },
    { cardId: 'req-2', kind: 'plan', deadline: 120_000, label: 'Qclod одобрит план' }
  ],
  limitWait: null,
  gaveUp: null
}

describe('autoAnswerTimer / toAutoAnswerView', () => {
  test('autoAnswerTimer находит таймер по cardId, иначе null', () => {
    expect(autoAnswerTimer(view, 'req-2')).toEqual(view.timers[1])
    expect(autoAnswerTimer(view, 'нет-такого')).toBeNull()
    expect(autoAnswerTimer(undefined, 'tu-1')).toBeNull()
  })

  test('toAutoAnswerView(null) — undefined', () => {
    expect(toAutoAnswerView(null, 't1')).toBeUndefined()
  })

  test('вид таймера: срок и подпись, кнопки уходят в preload с id вкладки и карточки; отказ IPC не всплывает', async () => {
    const autonomyAnswerNow = vi.fn(() => Promise.reject(new Error('нет')))
    const autonomyHold = vi.fn(() => Promise.resolve())
    vi.stubGlobal('qclod', { autonomyAnswerNow, autonomyHold })
    const shown = toAutoAnswerView(view.timers[0]!, 't1')!
    expect(shown).toMatchObject({ deadline: 90_000, label: 'Qclod выберет «Да»' })
    shown.onAnswerNow()
    shown.onStop()
    expect(autonomyAnswerNow).toHaveBeenCalledWith('t1', 'tu-1')
    expect(autonomyHold).toHaveBeenCalledWith('t1', 'tu-1')
    // A refusal is swallowed: the timer simply stays.
    await new Promise((resolve) => setTimeout(resolve, 0))
    vi.unstubAllGlobals()
  })
})

describe('AutoAnswerGuard', () => {
  let host: HTMLDivElement
  let root: Root
  let now = 0
  beforeEach(() => {
    now = 0
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

  /** A fresh guard around one button; returns the button. */
  function mount(active: boolean, onStop: () => void): HTMLElement {
    act(() => root.unmount())
    root = createRoot(host)
    act(() =>
      root.render(
        createElement(AutoAnswerGuard, {
          active,
          onStop,
          children: createElement('button', { 'data-testid': 'inside' }, 'Да')
        })
      )
    )
    // Keys pressed in the card's first moments never count.
    now += ARM_MS
    return host.querySelector('[data-testid="inside"]') as HTMLElement
  }
  const fire = (el: HTMLElement, event: Event): void => act(() => void el.dispatchEvent(event))

  test('AutoAnswerGuard: первый pointerdown зовёт onStop один раз; keydown тоже; при active false — нет', () => {
    const byPointer = vi.fn()
    const a = mount(true, byPointer)
    fire(a, new Event('pointerdown', { bubbles: true }))
    fire(a, new Event('pointerdown', { bubbles: true }))
    fire(a, new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(byPointer).toHaveBeenCalledTimes(1)

    const byKey = vi.fn()
    fire(mount(true, byKey), new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    expect(byKey).toHaveBeenCalledTimes(1)

    const byInput = vi.fn()
    fire(mount(true, byInput), new Event('input', { bubbles: true }))
    expect(byInput).toHaveBeenCalledTimes(1)

    // The countdown's own buttons are not the person answering the card.
    const byStrip = vi.fn()
    act(() => root.unmount())
    root = createRoot(host)
    act(() =>
      root.render(
        createElement(AutoAnswerGuard, {
          active: true,
          onStop: byStrip,
          children: createElement(
            'div',
            { 'data-testid': 'auto-answer' },
            createElement('button', { id: 'now' }, 'Ответить сейчас')
          )
        })
      )
    )
    fire(host.querySelector('#now') as HTMLElement, new Event('pointerdown', { bubbles: true }))
    expect(byStrip).not.toHaveBeenCalled()

    const idle = vi.fn()
    const off = mount(false, idle)
    fire(off, new Event('pointerdown', { bubbles: true }))
    fire(off, new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(idle).not.toHaveBeenCalled()
  })

  test('AutoAnswerGuard: переключение окон и вкладок, Tab, F-клавиши, автоповтор и зажатые заранее клавиши таймер не снимают', () => {
    const key = (init: KeyboardEventInit): KeyboardEvent =>
      new KeyboardEvent('keydown', { bubbles: true, ...init })
    const passive = vi.fn()
    const el = mount(true, passive)
    fire(el, key({ key: 'Alt', code: 'AltLeft', altKey: true }))
    fire(el, key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))
    fire(el, key({ key: 'Tab', code: 'Tab', ctrlKey: true }))
    fire(el, key({ key: 'Tab', code: 'Tab', altKey: true }))
    fire(el, key({ key: '1', code: 'Digit1', ctrlKey: true }))
    fire(el, key({ key: 'k', code: 'KeyK', ctrlKey: true }))
    fire(el, key({ key: 'Meta', code: 'MetaLeft', metaKey: true }))
    fire(el, key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))
    fire(el, key({ key: 'Tab', code: 'Tab' }))
    fire(el, key({ key: 'Tab', code: 'Tab', shiftKey: true }))
    fire(el, key({ key: 'F5', code: 'F5' }))
    fire(el, key({ key: 'a', code: 'KeyA', repeat: true }))
    expect(passive).not.toHaveBeenCalled()

    for (const [k, code] of [
      ['1', 'Digit1'],
      ['a', 'KeyA'],
      ['Enter', 'Enter']
    ] as const) {
      const stop = vi.fn()
      fire(mount(true, stop), key({ key: k, code }))
      expect(stop).toHaveBeenCalledTimes(1)
    }

    // Too early: the card has only just come.
    const early = vi.fn()
    const e = mount(true, early)
    now -= ARM_MS
    fire(e, key({ key: 'a', code: 'KeyA' }))
    expect(early).not.toHaveBeenCalled()

    // A key already down when the card arrived — someone still typing — does not stop it.
    trackHeldKeys()
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB' })))
    const held = vi.fn()
    const h = mount(true, held)
    fire(h, key({ key: 'b', code: 'KeyB' }))
    fire(h, new Event('input', { bubbles: true }))
    expect(held).not.toHaveBeenCalled()
    fire(h, new KeyboardEvent('keyup', { key: 'b', code: 'KeyB', bubbles: true }))
    fire(h, key({ key: 'b', code: 'KeyB' }))
    expect(held).toHaveBeenCalledTimes(1)
  })
})

describe('пометка «авто» в ленте', () => {
  const answers: CardAnswers = { permission: vi.fn(), question: vi.fn(), plan: vi.fn() }
  const row = (item: RibbonItem): string =>
    renderToStaticMarkup(
      createElement(RibbonRow, {
        item,
        byParent: new Map(),
        cwd: 'C:/проект',
        tabId: 't1',
        onMeasure: () => undefined,
        answers
      })
    )
  const tags = (html: string): number => (html.match(/data-testid="auto-tag"/g) ?? []).length

  test('пузырь пользователя с auto рисует AutoTag, отвеченная карточка с auto — ровно один auto-tag', () => {
    const user: RibbonItem = { id: 'u1', kind: 'user', text: 'продолжай', attachments: [], auto: true }
    expect(tags(row(user))).toBe(1)
    expect(tags(row({ ...user, auto: undefined } as RibbonItem))).toBe(0)

    const question: RibbonItem = {
      id: 'q1',
      kind: 'question',
      toolUseId: 'tu-1',
      questions: [{ question: 'Куда?', header: '', options: [{ label: 'Да', description: '' }], multiSelect: false }],
      answers: { 'Куда?': 'Да (Recommended)' },
      auto: true
    }
    expect(tags(row(question))).toBe(1)
  })
})
