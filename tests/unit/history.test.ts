import { describe, expect, test } from 'vitest'
import { InputHistory } from '@renderer/input/history'

describe('InputHistory', () => {
  test('prev выдаёт записи от новых к старым', () => {
    const h = new InputHistory()
    h.push('first')
    h.push('second')
    expect(h.prev('')).toBe('second')
    expect(h.prev('')).toBe('first')
  })

  test('на самой старой записи prev больше не двигается', () => {
    const h = new InputHistory()
    h.push('only')
    expect(h.prev('')).toBe('only')
    expect(h.prev('')).toBe('only')
  })

  test('next возвращает обратно к пустой строке', () => {
    const h = new InputHistory()
    h.push('first')
    h.push('second')
    h.prev('')
    h.prev('')
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
    expect(h.prev('')).toBe('same')
    expect(h.prev('')).toBe('same')
    expect(h.size).toBe(1)
  })

  test('пустые строки не попадают в историю', () => {
    const h = new InputHistory()
    h.push('   ')
    h.push('')
    expect(h.size).toBe(0)
    expect(h.prev('')).toBeUndefined()
  })

  test('reset сбрасывает позицию, но не содержимое', () => {
    const h = new InputHistory()
    h.push('first')
    h.push('second')
    h.prev('')
    h.prev('')
    h.reset()
    expect(h.size).toBe(2)
    expect(h.prev('')).toBe('second')
  })

  test('новая запись сбрасывает позицию', () => {
    const h = new InputHistory()
    h.push('first')
    h.prev('')
    h.push('second')
    expect(h.prev('')).toBe('second')
  })

  test('история ограничена сверху и выбрасывает самое старое', () => {
    const h = new InputHistory([], 3)
    for (const text of ['a', 'b', 'c', 'd']) h.push(text)
    expect(h.size).toBe(3)
    expect(h.entries).toEqual(['b', 'c', 'd'])
  })

  test('↓ после самой новой записи возвращает черновик, а не пустую строку', () => {
    const h = new InputHistory(['раз', 'два'])
    expect(h.prev('недописанное')).toBe('два')
    expect(h.next()).toBe('недописанное')
  })

  test('черновик запоминается на первом шаге и не затирается следующими', () => {
    const h = new InputHistory(['раз', 'два'])
    h.prev('черновик')
    expect(h.prev('два')).toBe('раз')
    expect(h.next()).toBe('два')
    expect(h.next()).toBe('черновик')
    expect(h.next()).toBeUndefined()
  })

  test('записи из ленты: старые первыми, ↑ даёт самую новую', () => {
    const h = new InputHistory()
    h.setEntries(['а', 'б', 'в'])
    expect(h.entries).toEqual(['а', 'б', 'в'])
    expect(h.prev('')).toBe('в')
    expect(h.prev('')).toBe('б')
  })

  test('подряд одинаковые записи ленты схлопываются', () => {
    const h = new InputHistory()
    h.setEntries(['а', 'а', 'б', 'б', 'а'])
    expect(h.entries).toEqual(['а', 'б', 'а'])
  })

  test('новая запись в ленте не сбивает просмотр', () => {
    const h = new InputHistory(['а', 'б'])
    h.prev('чер')
    h.setEntries(['а', 'б'])
    expect(h.prev('')).toBe('а')
    expect(h.next()).toBe('б')
    expect(h.next()).toBe('чер')
  })

  test('правка вызванной записи: ↓ возвращает исходный черновик', () => {
    const h = new InputHistory(['а', 'б'])
    h.prev('чер')
    h.edit()
    expect(h.next()).toBe('чер')
    expect(h.next()).toBeUndefined()
  })

  test('после правки ↑ листает дальше, черновик цел', () => {
    const h = new InputHistory(['а', 'б'])
    h.prev('чер')
    h.edit()
    expect(h.prev('б!')).toBe('а')
    expect(h.next()).toBe('б')
    h.edit()
    expect(h.next()).toBe('чер')
  })

  test('новая запись посреди просмотра: позиция остаётся на той же записи', () => {
    const h = new InputHistory(['а', 'б', 'в'])
    h.prev('чер')
    expect(h.prev('')).toBe('б')
    h.setEntries(['а', 'б', 'в', 'г'])
    expect(h.prev('')).toBe('а')
    expect(h.next()).toBe('б')
    expect(h.next()).toBe('в')
    expect(h.next()).toBe('г')
    expect(h.next()).toBe('чер')
  })

  test('setEntries вне просмотра оставляет позицию «не листаем»', () => {
    const h = new InputHistory(['а'])
    h.setEntries(['а', 'б'])
    expect(h.next()).toBeUndefined()
    expect(h.prev('')).toBe('б')
  })
})

describe('InputHistory: черновик в поездке по истории', () => {
  test('browsing и release: черновик возвращается ровно, записи не портятся', () => {
    const h = new InputHistory(['первое', 'второе'])
    expect(h.browsing).toBe(false)
    expect(h.prev('строка\nчерновика')).toBe('второе')
    expect(h.browsing).toBe(true)
    h.edit()
    expect(h.release()).toBe('строка\nчерновика')
    expect(h.browsing).toBe(false)
    expect(h.release()).toBeUndefined()
    expect(h.entries).toEqual(['первое', 'второе'])
  })

  test('несколько шагов назад и столько же вперёд — тот же черновик', () => {
    const h = new InputHistory(['а', 'б', 'в'])
    h.prev('мой')
    h.prev('в')
    h.prev('б')
    expect(h.next()).toBe('б')
    expect(h.next()).toBe('в')
    expect(h.next()).toBe('мой')
    expect(h.browsing).toBe(false)
  })
})
