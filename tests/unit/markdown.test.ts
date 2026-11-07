import { describe, expect, test } from 'vitest'
import { parseInline, parseMarkdown, type Block } from '@renderer/markdown/parse'
import { highlight } from '@renderer/markdown/highlight'

function text(block: Block): string {
  if (block.kind === 'paragraph' || block.kind === 'heading') {
    return block.spans.map((s) => ('text' in s ? s.text : 'spans' in s ? s.spans.map((i) => ('text' in i ? i.text : '')).join('') : '')).join('')
  }
  return ''
}

describe('parseMarkdown: блоки', () => {
  test('заголовки разного уровня', () => {
    const blocks = parseMarkdown('# Раз\n\n### Три')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 })
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 3 })
    expect(text(blocks[0]!)).toBe('Раз')
  })

  test('абзацы разделяются пустой строкой', () => {
    const blocks = parseMarkdown('первый абзац\nпродолжение\n\nвторой')
    expect(blocks).toHaveLength(2)
    expect(text(blocks[0]!)).toBe('первый абзац\nпродолжение')
  })

  test('блок кода с языком', () => {
    const blocks = parseMarkdown('Вот код:\n\n```ts\nconst x = 1\n```')
    expect(blocks[1]).toEqual({ kind: 'code', language: 'ts', code: 'const x = 1' })
  })

  test('незакрытый блок кода всё равно код — агент ещё печатает', () => {
    const blocks = parseMarkdown('```python\nprint("привет")')
    expect(blocks[0]).toMatchObject({ kind: 'code', language: 'python' })
  })

  test('внутри кода звёздочки остаются звёздочками', () => {
    const blocks = parseMarkdown('```\nx = a ** b\n```')
    expect(blocks[0]).toMatchObject({ code: 'x = a ** b' })
  })

  test('маркированный и нумерованный списки', () => {
    const bullets = parseMarkdown('- раз\n- два')
    expect(bullets[0]).toMatchObject({ kind: 'list', ordered: false })
    expect((bullets[0] as { items: unknown[] }).items).toHaveLength(2)

    const numbered = parseMarkdown('3. третий\n4. четвёртый')
    expect(numbered[0]).toMatchObject({ kind: 'list', ordered: true, start: 3 })
  })

  test('вложенный список попадает внутрь своего пункта', () => {
    const blocks = parseMarkdown('- верх\n  - низ\n- второй верх')
    const list = blocks[0] as Extract<Block, { kind: 'list' }>
    expect(list.items).toHaveLength(2)
    expect(list.items[0]!.children).toHaveLength(1)
    expect(list.items[0]!.children[0]).toMatchObject({ kind: 'list' })
  })

  test('чек-лист распознаётся', () => {
    const list = parseMarkdown('- [x] сделано\n- [ ] не сделано') as [
      Extract<Block, { kind: 'list' }>
    ]
    expect(list[0].items[0]!.checked).toBe(true)
    expect(list[0].items[1]!.checked).toBe(false)
  })

  test('цитата', () => {
    const blocks = parseMarkdown('> это цитата\n> вторая строка')
    expect(blocks[0]).toMatchObject({ kind: 'quote' })
  })

  test('горизонтальная черта', () => {
    expect(parseMarkdown('---')[0]).toEqual({ kind: 'rule' })
    expect(parseMarkdown('***')[0]).toEqual({ kind: 'rule' })
  })

  test('таблица с заголовком', () => {
    const blocks = parseMarkdown('| имя | цена |\n| --- | --- |\n| хлеб | 50 |\n| соль | 20 |')
    const table = blocks[0] as Extract<Block, { kind: 'table' }>
    expect(table.kind).toBe('table')
    expect(table.head).toHaveLength(2)
    expect(table.rows).toHaveLength(2)
  })

  test('таблица без разделителя — обычный текст', () => {
    // Otherwise any sentence with a pipe becomes a table.
    expect(parseMarkdown('a | b')[0]).toMatchObject({ kind: 'paragraph' })
  })

  test('пустой текст не даёт блоков', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n  \n')).toEqual([])
  })
})

describe('parseInline', () => {
  test('жирный, курсив, зачёркнутый', () => {
    expect(parseInline('**жирный**')[0]).toMatchObject({ kind: 'strong' })
    expect(parseInline('*курсив*')[0]).toMatchObject({ kind: 'em' })
    expect(parseInline('~~зачёркнуто~~')[0]).toMatchObject({ kind: 'strike' })
  })

  test('код важнее остального', () => {
    const spans = parseInline('`a ** b` потом **жирный**')
    expect(spans[0]).toEqual({ kind: 'code', text: 'a ** b' })
    expect(spans.at(-1)).toMatchObject({ kind: 'strong' })
  })

  test('подчёркивания внутри имени не делают курсив', () => {
    // snake_case_identifier must survive intact.
    const spans = parseInline('файл snake_case_name готов')
    expect(spans.every((s) => s.kind === 'text')).toBe(true)
  })

  test('ссылка в скобках и голая ссылка', () => {
    expect(parseInline('[текст](https://example.com)')[0]).toMatchObject({
      kind: 'link',
      href: 'https://example.com'
    })
    expect(parseInline('смотри https://example.com/a сюда')[1]).toMatchObject({ kind: 'link' })
  })

  test('незакрытая звёздочка остаётся текстом', () => {
    const spans = parseInline('умножение 2 * 3 без пары')
    expect(spans.every((s) => s.kind === 'text')).toBe(true)
  })

  test('экранированная звёздочка печатается как есть', () => {
    expect(parseInline('\\*не курсив\\*')).toEqual([{ kind: 'text', text: '*не курсив*' }])
  })
})

describe('highlight', () => {
  test('строки, числа, ключевые слова и комментарии', () => {
    const [line] = highlight('const x = 42 // счёт', 'ts')
    const kinds = line!.map((t) => t.kind)
    expect(kinds).toContain('keyword')
    expect(kinds).toContain('number')
    expect(kinds).toContain('comment')
  })

  test('в Python решётка — комментарий, а не число', () => {
    const [line] = highlight('# заметка', 'python')
    expect(line![0]!.kind).toBe('comment')
  })

  test('строка с апострофом не рвёт остаток строки', () => {
    const [line] = highlight(`print('привет') # потом`, 'python')
    expect(line!.some((t) => t.kind === 'string' && t.text.includes('привет'))).toBe(true)
    expect(line!.at(-1)!.kind).toBe('comment')
  })

  test('число строк сохраняется', () => {
    expect(highlight('a\nb\nc')).toHaveLength(3)
  })

  test('пустой код не падает', () => {
    expect(highlight('')).toEqual([[]])
  })
})
