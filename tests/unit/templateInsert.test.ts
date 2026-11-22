import { describe, expect, test, vi } from 'vitest'
import {
  TEMPLATE_ITEM_PREFIX,
  applyTemplateFromSlash,
  insertTemplate,
  templateHits,
  templateItems
} from '@renderer/input/templates'
import { templatesProvider } from '@renderer/palette/templates'
import type { PaletteContext } from '@renderer/palette/types'
import type { PromptTemplate } from '@shared/types'

function tpl(id: string, title: string, body: string, updatedAt = 1): PromptTemplate {
  return { id, title, body, origin: 'manual', createdAt: updatedAt, updatedAt }
}

describe('insertTemplate', () => {
  test('вставка в место курсора выделяет первое {{…}}', () => {
    expect(insertTemplate('ab', 1, 1, 'X {{файл}} Y')).toEqual({ text: 'aX {{файл}} Yb', selStart: 3, selEnd: 11 })
  })

  test('без {{ курсор в конце вставки', () => {
    expect(insertTemplate('ab', 1, 1, 'XYZ')).toEqual({ text: 'aXYZb', selStart: 4, selEnd: 4 })
  })

  test('выделение заменяется', () => {
    expect(insertTemplate('начало СТАРОЕ конец', 7, 13, 'новое')).toEqual({
      text: 'начало новое конец',
      selStart: 12,
      selEnd: 12
    })
  })

  test('выделяется первое из нескольких мест, а не скобки из черновика', () => {
    const r = insertTemplate('{{был}} ', 8, 8, 'A {{один}} B {{два}}')
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('{{один}}')
  })

  test('/ — «/запрос» заменяется текстом шаблона, хвост остаётся', () => {
    const r = applyTemplateFromSlash('/рев хвост', 4, 'Проверь {{что}}')
    expect(r.text).toBe('Проверь {{что}} хвост')
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('{{что}}')
  })
})

describe('templateItems: шаблоны в списке /', () => {
  const list = [
    tpl('a', 'Тесты для модуля', 'Напиши тесты', 3),
    tpl('b', 'Ревью ветки', 'Сделай ревью {{ветки}}\nи перечисли проблемы', 2),
    tpl('c', 'Разобрать ревью', 'Упрости код', 1)
  ]

  test('tpl:-id, подсказка «шаблон», порядок по совпадению', () => {
    const items = templateItems(list, 'рев')
    expect(items.map((i) => i.id)).toEqual([`${TEMPLATE_ITEM_PREFIX}b`, `${TEMPLATE_ITEM_PREFIX}c`])
    expect(items[0]).toEqual({
      id: 'tpl:b',
      primary: 'Ревью ветки',
      secondary: 'Сделай ревью {{ветки}}',
      hint: 'шаблон'
    })
  })

  test('пустой запрос — не больше 8, новые сверху', () => {
    const many = Array.from({ length: 12 }, (_v, i) => tpl(`t${i}`, `Шаблон ${i}`, 'текст', i))
    const items = templateItems(many, '')
    expect(items).toHaveLength(8)
    expect(items[0]!.id).toBe('tpl:t11')
    expect(items[7]!.id).toBe('tpl:t4')
  })

  test('длинная первая строка обрезается до 80', () => {
    const items = templateItems([tpl('x', 'X', 'я'.repeat(200))], '')
    expect(items[0]!.secondary!.length).toBe(80)
  })
})

describe('templateHits: Ctrl+K', () => {
  const list = [tpl('a', 'Ревью', 'проверь всё', 1), tpl('b', 'Тесты', 'напиши ревью тестов', 2)]

  test('по названию выше, чем по тексту; лимит 8', () => {
    const hits = templateHits(list, 'ревью')
    expect(hits.map((h) => h.id)).toEqual(['a', 'b'])
    expect(hits[0]!.points).toBeGreaterThan(hits[1]!.points)
    const many = Array.from({ length: 20 }, (_v, i) => tpl(`t${i}`, `Ревью ${i}`, 'x', i))
    expect(templateHits(many, 'ревью')).toHaveLength(8)
  })

  test('источник «Шаблоны» вставляет текст через runner', () => {
    const insertTemplate = vi.fn()
    const ctx = { templates: list, run: { insertTemplate } } as unknown as PaletteContext
    const rows = templatesProvider.items('тесты', ctx)
    expect(templatesProvider.title).toBe('Шаблоны')
    expect(rows[0]).toMatchObject({ section: 'templates', title: 'Тесты' })
    rows[0]!.run()
    expect(insertTemplate).toHaveBeenCalledWith('напиши ревью тестов')
    expect(templatesProvider.items('', ctx)).toEqual([])
    expect(templatesProvider.items('', ctx, true)).toHaveLength(2)
  })
})
