import { describe, expect, test } from 'vitest'
import { contextSegments } from '../../src/renderer/panel/contextSegments'

describe('contextSegments', () => {
  test('части по порядку CLI, свободное в конце, доли в сумме 1', () => {
    const s = contextSegments(
      [
        { name: 'System prompt', tokens: 3000, kind: 'used' },
        { name: 'Messages', tokens: 7000, kind: 'used' },
        { name: 'Free space', tokens: 90000, kind: 'free' }
      ],
      100000
    )
    expect(s.map((x) => x.fill)).toEqual(['seg-1', 'seg-2', 'seg-free'])
    expect(s.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1)
  })

  test('седьмая строка и дальше — «Другое»', () => {
    const used = Array.from({ length: 8 }, (_, i) => ({ name: `Row ${i}`, tokens: 1000, kind: 'used' as const }))
    const s = contextSegments(used, 10000)
    expect(s.map((x) => x.fill).slice(0, 7)).toEqual(['seg-1', 'seg-2', 'seg-3', 'seg-4', 'seg-5', 'seg-6', 'seg-6'])
    const other = s[6]
    expect(other.name).toBe('Другое')
    expect(other.tokens).toBe(2000)
    expect(s[s.length - 1].name).toBe('Свободно')
  })

  test('нет строки free — остаток добавлен как «Свободно»', () => {
    const s = contextSegments([{ name: 'messages', tokens: 25000, kind: 'used' }], 100000)
    const free = s[s.length - 1]
    expect(free).toMatchObject({ name: 'Свободно', tokens: 75000, fill: 'seg-free' })
    expect(free.share).toBeCloseTo(0.75)
  })

  test('нулевые строки не рисуются', () => {
    const s = contextSegments(
      [
        { name: 'Skills', tokens: 0, kind: 'used' },
        { name: 'Messages', tokens: 500, kind: 'used' },
        { name: 'Autocompact buffer', tokens: 0, kind: 'buffer' },
        { name: 'Free space', tokens: 500, kind: 'free' }
      ],
      1000
    )
    expect(s.map((x) => x.name)).toEqual(['Сообщения', 'Свободно'])
  })

  test('резерв называется по kind, свободное — «Свободно» при любом имени CLI', () => {
    const s = contextSegments(
      [
        { name: 'messages', tokens: 100, kind: 'used' },
        { name: 'Autocompact buffer', tokens: 30, kind: 'buffer' },
        { name: 'Free space', tokens: 70, kind: 'free' }
      ],
      200
    )
    expect(s.map((x) => [x.name, x.fill])).toEqual([
      ['Сообщения', 'seg-1'],
      ['Резерв сжатия', 'seg-buffer'],
      ['Свободно', 'seg-free']
    ])
  })

  test('строки без kind считаются занятыми; пустой список даёт одну полосу «Свободно»', () => {
    expect(contextSegments([{ name: 'system_prompt', tokens: 10 }], 100)[0]).toMatchObject({
      name: 'Системный промпт',
      fill: 'seg-1'
    })
    expect(contextSegments([], 100).map((x) => x.name)).toEqual(['Свободно'])
  })
})
