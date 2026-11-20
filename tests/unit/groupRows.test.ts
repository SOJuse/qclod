import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { groupLabel, groupRows } from '../../src/renderer/chat/groupRows'
import { RibbonRow } from '../../src/renderer/components/RibbonItem'
import type { RibbonItem } from '../../src/shared/types'

const tool = (id: string, name: string, state: 'running' | 'done' = 'done'): RibbonItem => ({
  id,
  kind: 'tool',
  toolUseId: `tu-${id}`,
  name,
  target: `${id}.ts`,
  summary: '',
  detail: '',
  state
})
const toolError = (id: string, name: string): RibbonItem => ({
  id,
  kind: 'toolError',
  toolUseId: `tu-${id}`,
  name,
  target: `${id}.ts`,
  error: 'нет такого файла'
})
const thinking = (id: string, done = true): RibbonItem => ({ id, kind: 'thinking', text: 'думаю', done, durationMs: 12000 })
const text = (id: string): RibbonItem => ({ id, kind: 'agentText', text: 'вот', streaming: false })
const perm = (id: string, state: 'pending' | 'allowed'): RibbonItem => ({
  id,
  kind: 'permission',
  requestId: id,
  toolName: 'Bash',
  target: 'ls',
  state
})
const never = (): boolean => false

describe('groupRows', () => {
  it('12 Read подряд — одна группа «Прочитал 12 файлов»', () => {
    const rows = Array.from({ length: 12 }, (_, i) => tool(`r${i}`, 'Read'))
    const out = groupRows(rows, never)
    expect(out).toHaveLength(1)
    const g = out[0]!
    expect(g.kind).toBe('toolGroup')
    if (g.kind !== 'toolGroup') return
    expect(g.count).toBe(12)
    expect(g.category).toBe('read')
    expect(groupLabel(g.category, g.count, g.running)).toBe('Прочитал 12 файлов')
  })

  it('Read, thinking, Read — одна группа из двух вызовов', () => {
    const out = groupRows([tool('a', 'Read'), thinking('t'), tool('b', 'Read')], never)
    expect(out).toHaveLength(1)
    const g = out[0]!
    if (g.kind !== 'toolGroup') throw new Error('not a group')
    expect(g.count).toBe(2)
    expect(g.items.map((i) => i.id)).toEqual(['a', 't', 'b'])
  })

  it('размышление после последнего вызова группы остаётся строкой ленты', () => {
    const out = groupRows([tool('a', 'Read'), tool('b', 'Read'), thinking('t')], never)
    expect(out.map((r) => r.kind)).toEqual(['toolGroup', 'item'])
  })

  it('Read, текст агента, Read — две одиночные строки', () => {
    const out = groupRows([tool('a', 'Read'), text('x'), tool('b', 'Read')], never)
    expect(out.map((r) => r.kind)).toEqual(['item', 'item', 'item'])
  })

  it('Read и Grep рядом — не одна группа', () => {
    const out = groupRows([tool('a', 'Read'), tool('b', 'Grep')], never)
    expect(out.map((r) => r.kind)).toEqual(['item', 'item'])
  })

  it('агент и план всегда одиночные: два Agent подряд остаются двумя карточками (П18)', () => {
    const out = groupRows([tool('a', 'Agent'), tool('b', 'Agent'), tool('c', 'TodoWrite'), tool('d', 'TodoWrite')], never)
    expect(out.map((r) => r.kind)).toEqual(['item', 'item', 'item', 'item'])
  })

  it('id группы не меняется при добавлении вызова', () => {
    const two = groupRows([tool('a', 'Read'), tool('b', 'Read')], never)[0]!
    const three = groupRows([tool('a', 'Read'), tool('b', 'Read'), tool('c', 'Read')], never)[0]!
    expect(two.id).toBe('group:a')
    expect(three.id).toBe('group:a')
  })

  it('идущая группа', () => {
    const g = groupRows([tool('a', 'Read'), tool('b', 'Read'), tool('c', 'Read', 'running')], never)[0]!
    if (g.kind !== 'toolGroup') throw new Error('not a group')
    expect(g.running).toBe(true)
    expect(groupLabel(g.category, g.count, g.running)).toBe('Читает файлы: 3')
  })

  it('ранний вызов ещё идёт, а последний уже готов — группа всё равно идёт', () => {
    const g = groupRows([tool('a', 'Read', 'running'), tool('b', 'Read'), tool('c', 'Read')], never)[0]!
    if (g.kind !== 'toolGroup') throw new Error('not a group')
    expect(g.running).toBe(true)
    expect(groupLabel(g.category, g.count, g.running)).toBe('Читает файлы: 3')
  })

  it('отвеченные разрешения не рвут группу: perm, tool, perm, tool — одна группа из двух вызовов', () => {
    const out = groupRows([perm('p1', 'allowed'), tool('a', 'Bash'), perm('p2', 'allowed'), tool('b', 'Bash')], never)
    expect(out).toHaveLength(1)
    const g = out[0]!
    if (g.kind !== 'toolGroup') throw new Error('not a group')
    expect(g.count).toBe(2)
    expect(g.items.map((i) => i.id)).toEqual(['p1', 'a', 'p2', 'b'])
  })

  it('разрешение после последнего вызова остаётся строкой, а перед следующей группой — её началом', () => {
    const out = groupRows(
      [tool('a', 'Read'), tool('b', 'Read'), perm('p', 'allowed'), tool('c', 'Bash'), tool('d', 'Bash')],
      never
    )
    expect(out.map((r) => r.id)).toEqual(['group:a', 'group:p'])
    const lone = groupRows([tool('a', 'Read'), tool('b', 'Read'), perm('p', 'allowed'), text('x')], never)
    expect(lone.map((r) => r.id)).toEqual(['group:a', 'p', 'x'])
  })

  it('ждущее разрешение и отвеченные план и вопрос группу рвут', () => {
    const plan: RibbonItem = { id: 'pl', kind: 'plan', requestId: 'pl', text: '1', state: 'approved' }
    const q: RibbonItem = { id: 'q', kind: 'question', toolUseId: 'q', questions: [], answers: { a: 'b' } }
    for (const breaker of [perm('w', 'pending'), plan, q]) {
      const out = groupRows([tool('a', 'Read'), breaker, tool('b', 'Read')], never)
      expect(out.map((r) => r.kind)).toEqual(['item', 'item', 'item'])
    }
  })

  it('ошибка в группе', () => {
    const g = groupRows([tool('a', 'Read'), toolError('b', 'Read'), tool('c', 'Read')], never)[0]!
    if (g.kind !== 'toolGroup') throw new Error('not a group')
    expect(g.errors).toBe(1)
    expect(groupLabel(g.category, g.count, g.running, g.errors)).toBe('Прочитал 3 файла · 1 ошибка')
  })

  it('открытая карточка не строка', () => {
    const perm: RibbonItem = { id: 'p', kind: 'permission', requestId: 'p', toolName: 'Bash', target: 'ls', state: 'pending' }
    const out = groupRows([text('x'), perm], (i) => i.id === 'p')
    expect(out.map((r) => r.id)).toEqual(['x'])
  })

  it('подписи всех категорий, готово и идёт', () => {
    expect(groupLabel('search', 4, false)).toBe('Искал 4 раза')
    expect(groupLabel('search', 4, true)).toBe('Ищет: 4')
    expect(groupLabel('edit', 3, false)).toBe('Изменил 3 файла')
    expect(groupLabel('edit', 3, true)).toBe('Правит файлы: 3')
    expect(groupLabel('command', 5, false)).toBe('Выполнил 5 команд')
    expect(groupLabel('command', 5, true)).toBe('Выполняет команды: 5')
    expect(groupLabel('mcp', 3, false)).toBe('MCP: 3 вызова')
    expect(groupLabel('other', 3, false)).toBe('Инструменты: 3 вызова')
    expect(groupLabel('read', 5, false, 3)).toBe('Прочитал 5 файлов · 3 ошибки')
  })
})

describe('размышления', () => {
  const html = (item: RibbonItem): string =>
    renderToStaticMarkup(
      createElement(RibbonRow, {
        item,
        byParent: new Map(),
        cwd: 'C:\\p',
        tabId: 't1',
        onMeasure: () => undefined,
        answers: { permission: () => undefined, question: () => undefined, plan: () => undefined }
      })
    )

  it('идущее и законченное размышление — <details> без open', () => {
    for (const done of [false, true]) {
      const out = html(thinking('t', done))
      expect(out).toContain('<details')
      expect(out).not.toMatch(/<details[^>]*\sopen/)
    }
    expect(html(thinking('t', false))).toContain('Думает…')
    expect(html(thinking('t', true))).toContain('Думал 12 с')
  })
})
