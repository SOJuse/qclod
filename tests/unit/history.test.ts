import { describe, expect, test } from 'vitest'
import { InputHistory } from '@renderer/input/history'

describe('InputHistory', () => {
  test('prev выдаёт записи от новых к старым', () => {
    const h = new InputHistory()
    h.push('first')
    h.push('second')
    expect(h.prev()).toBe('second')
    expect(h.prev()).toBe('first')
  })

  test('на самой старой записи prev больше не двигается', () => {
    const h = new InputHistory()
    h.push('only')
    expect(h.prev()).toBe('only')
    expect(h.prev()).toBe('only')
  })

  test('next возвращает обратно к пустой строке', () => {
    const h = new InputHistory()
    h.push('first')
    h.push('second')
    h.prev()
    h.prev()
    expect(h.next()).toBe('second')
    expect(h.next()).toBe('')
  })

  test('next без предшествующего prev даёт undefined', () => {
    const h = new InputHistory()
    h.push('first')
    expect(h.next()).toBeUndefined()
  })

  test('повтор подряд одинакового текста не создаёт дубль', () => {
    const h = new InputHistory()
    h.push('same')
    h.push('same')
    expect(h.prev()).toBe('same')
    expect(h.prev()).toBe('same')
    expect(h.size).toBe(1)
  })

  test('пустые строки не попадают в историю', () => {
    const h = new InputHistory()
    h.push('   ')
    h.push('')
    expect(h.size).toBe(0)
    expect(h.prev()).toBeUndefined()
  })

  test('reset сбрасывает позицию, но не содержимое', () => {
    const h = new InputHistory()
    h.push('first')
    h.push('second')
    h.prev()
    h.prev()
    h.reset()
    expect(h.size).toBe(2)
    expect(h.prev()).toBe('second')
  })

  test('новая запись сбрасывает позицию', () => {
    const h = new InputHistory()
    h.push('first')
    h.prev()
    h.push('second')
    expect(h.prev()).toBe('second')
  })

  test('история ограничена сверху и выбрасывает самое старое', () => {
    const h = new InputHistory(3)
    for (const text of ['a', 'b', 'c', 'd']) h.push(text)
    expect(h.size).toBe(3)
    expect(h.entries).toEqual(['b', 'c', 'd'])
  })
})
