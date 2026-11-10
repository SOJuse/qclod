import { describe, expect, test, vi } from 'vitest'
import { rememberFocus, trapStep, trapTab } from '../../src/renderer/ui/modalFocus'

/** Just enough of an element for the helpers: they only focus, measure and ask if it is attached. */
interface FakeEl {
  name: string
  isConnected: boolean
  visible: boolean
  focus: ReturnType<typeof vi.fn>
  getClientRects: () => { length: number }
}

const el = (name: string, opts: Partial<Pick<FakeEl, 'isConnected' | 'visible'>> = {}): FakeEl => {
  const e: FakeEl = {
    name,
    isConnected: opts.isConnected ?? true,
    visible: opts.visible ?? true,
    focus: vi.fn(),
    getClientRects: () => ({ length: e.visible ? 1 : 0 })
  }
  return e
}
const asEl = (e: FakeEl | null): Element | null => e as unknown as Element | null
const doc = (active: FakeEl | null, body: FakeEl) => ({
  activeElement: asEl(active),
  body: body as unknown as HTMLElement
})

describe('rememberFocus: окно закрылось — фокус туда, откуда его открыли', () => {
  test('возвращает фокус элементу, который был активен при открытии', () => {
    const opener = el('open-settings')
    const d = doc(opener, el('body'))
    const restore = rememberFocus(d)
    d.activeElement = asEl(el('sheet'))
    opener.focus.mockImplementation(() => (d.activeElement = asEl(opener)))
    const lost = vi.fn()
    restore(lost)
    expect(opener.focus).toHaveBeenCalledTimes(1)
    expect(d.activeElement).toBe(asEl(opener))
    expect(lost).not.toHaveBeenCalled()
  })

  test('открывший элемент на месте, но фокус не принял (поле стало disabled) — запасной путь', () => {
    const opener = el('composer-input')
    const d = doc(opener, el('body'))
    const restore = rememberFocus(d)
    d.activeElement = d.body // the sheet is gone; a disabled field's focus() does nothing
    const lost = vi.fn()
    restore(lost)
    expect(opener.focus).toHaveBeenCalledTimes(1)
    expect(lost).toHaveBeenCalledTimes(1)
  })

  test('открывший элемент исчез из документа — запасной путь', () => {
    const opener = el('palette-field')
    const restore = rememberFocus(doc(opener, el('body')))
    opener.isConnected = false
    const lost = vi.fn()
    restore(lost)
    expect(opener.focus).not.toHaveBeenCalled()
    expect(lost).toHaveBeenCalledTimes(1)
  })

  test('при открытии фокус был на body или нигде — запасной путь, а не body', () => {
    const body = el('body')
    const lost = vi.fn()
    rememberFocus(doc(body, body))(lost)
    rememberFocus(doc(null, body))(lost)
    expect(body.focus).not.toHaveBeenCalled()
    expect(lost).toHaveBeenCalledTimes(2)
  })

  test('без запасного пути не падает', () => {
    expect(() => rememberFocus(doc(null, el('body')))()).not.toThrow()
  })
})

describe('trapStep: Tab не уходит за лист', () => {
  const items = ['a', 'b', 'c']
  test('с последнего Tab идёт на первый', () => expect(trapStep(items, 'c', false)).toBe('a'))
  test('с первого Shift+Tab идёт на последний', () => expect(trapStep(items, 'a', true)).toBe('c'))
  test('в середине браузер двигает фокус сам', () => {
    expect(trapStep(items, 'b', false)).toBeNull()
    expect(trapStep(items, 'b', true)).toBeNull()
  })
  test('фокус на самом листе или снаружи — на первый или последний', () => {
    expect(trapStep(items, 'sheet', false)).toBe('a')
    expect(trapStep(items, null, true)).toBe('c')
  })
  test('один элемент — фокус остаётся на нём', () => {
    expect(trapStep(['a'], 'a', false)).toBe('a')
    expect(trapStep(['a'], 'a', true)).toBe('a')
  })
  test('пустой лист — некуда', () => expect(trapStep([], null, false)).toBeNull())
})

describe('trapTab на листе', () => {
  const sheetWith = (items: FakeEl[]) => ({
    querySelectorAll: () => items as unknown as NodeListOf<HTMLElement>
  })
  const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, preventDefault: vi.fn() })

  test('Tab с последнего видимого переводит на первый и гасит действие браузера', () => {
    const first = el('first')
    const last = el('last')
    const ev = key('Tab')
    trapTab(sheetWith([first, last, el('hidden', { visible: false })]), ev, asEl(last))
    expect(ev.preventDefault).toHaveBeenCalled()
    expect(first.focus).toHaveBeenCalled()
  })

  test('Shift+Tab с первого — на последний видимый', () => {
    const first = el('first')
    const last = el('last')
    const ev = key('Tab', true)
    trapTab(sheetWith([first, last, el('hidden', { visible: false })]), ev, asEl(first))
    expect(ev.preventDefault).toHaveBeenCalled()
    expect(last.focus).toHaveBeenCalled()
  })

  test('Tab в середине не трогает', () => {
    const items = [el('1'), el('2'), el('3')]
    const ev = key('Tab')
    trapTab(sheetWith(items), ev, asEl(items[1]!))
    expect(ev.preventDefault).not.toHaveBeenCalled()
    for (const i of items) expect(i.focus).not.toHaveBeenCalled()
  })

  test('в листе нечего фокусировать — Tab всё равно не выпускает', () => {
    const ev = key('Tab', true)
    trapTab(sheetWith([el('hidden', { visible: false })]), ev, null)
    expect(ev.preventDefault).toHaveBeenCalled()
  })

  test('другие клавиши не трогает', () => {
    const only = el('only')
    const ev = key('Enter')
    trapTab(sheetWith([only]), ev, asEl(only))
    expect(ev.preventDefault).not.toHaveBeenCalled()
    expect(only.focus).not.toHaveBeenCalled()
  })
})
