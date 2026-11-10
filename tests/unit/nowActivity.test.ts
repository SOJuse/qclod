import { describe, expect, test } from 'vitest'
import { nowActivity } from '../../src/renderer/chat/nowActivity'
import type { RibbonItem } from '../../src/shared/types'

let seq = 0

function runningTool(name: string, input: Record<string, unknown>, target = ''): RibbonItem {
  seq++
  return {
    kind: 'tool',
    id: `t${seq}`,
    toolUseId: `u${seq}`,
    name,
    target,
    summary: '',
    detail: '',
    state: 'running',
    input
  }
}

function doneTool(name: string): RibbonItem {
  return { ...(runningTool(name, {}) as Extract<RibbonItem, { kind: 'tool' }>), state: 'done' }
}

function subagent(
  task: string,
  state: 'running' | 'done' = 'running',
  extra: { background?: boolean; lastTool?: string; name?: string } = {}
): RibbonItem {
  seq++
  return {
    kind: 'subagent',
    id: `s${seq}`,
    toolUseId: `su${seq}`,
    name: extra.name ?? 'Explore',
    task,
    state,
    summary: '',
    ...(extra.background ? { background: true } : {}),
    ...(extra.lastTool ? { lastTool: extra.lastTool } : {})
  }
}

describe('nowActivity', () => {
  test('Read — «Читает» и имя файла', () => {
    expect(nowActivity([runningTool('Read', { file_path: 'C:\\p\\src\\index.ts' })], 'busy')).toMatchObject({
      category: 'read',
      verb: 'Читает',
      object: 'index.ts',
      objectKind: 'path',
      path: 'C:\\p\\src\\index.ts'
    })
  })

  test('Bash — «Запускает» и команда', () => {
    expect(nowActivity([runningTool('Bash', { command: 'npm test\necho done' })], 'busy')).toMatchObject({
      category: 'command',
      verb: 'Запускает',
      object: 'npm test',
      objectKind: 'code'
    })
  })

  test('Grep — «Ищет» и шаблон в кавычках', () => {
    expect(nowActivity([runningTool('Grep', { pattern: 'toolUseId' })], 'busy')).toMatchObject({
      category: 'search',
      verb: 'Ищет',
      object: '"toolUseId"'
    })
  })

  test('ожидание разрешения — «Ждёт ответа»', () => {
    expect(nowActivity([runningTool('Bash', { command: 'npm test' })], 'waiting')).toMatchObject({
      category: 'waiting',
      verb: 'Ждёт ответа',
      objectKind: 'none'
    })
  })

  test('свободная сессия — null', () => expect(nowActivity([], 'idle')).toBeNull())

  test('конец хода с законченными шагами — null', () => {
    expect(nowActivity([doneTool('Read'), subagent('готово', 'done')], 'idle')).toBeNull()
  })

  test('работающие подагенты считаются', () => {
    const items = [subagent('первый', 'running', { background: true }), subagent('второй', 'running', { background: true })]
    const now = nowActivity(items, 'busy')
    expect(now?.runningAgents).toHaveLength(2)
    expect(now?.runningAgents.map((a) => a.task)).toEqual(['первый', 'второй'])
    // A background agent is not what the main agent is doing.
    expect(now?.verb).toBe('Думает')
  })

  test('сессия свободна, но два подагента работают — строка без глагола', () => {
    const items = [
      subagent('прогнать тесты', 'running', { background: true, lastTool: 'Bash', name: 'builder' }),
      subagent('найти вызовы', 'running', { background: true })
    ]
    expect(nowActivity(items, 'idle')).toEqual({
      category: 'agent',
      verb: '',
      object: '',
      objectKind: 'none',
      runningAgents: [
        { id: items[0]!.id, name: 'builder', task: 'прогнать тесты', lastTool: 'Bash' },
        { id: items[1]!.id, name: 'Explore', task: 'найти вызовы' }
      ]
    })
  })

  test('подагент, которого ждёт ход, назван глаголом и не повторён в списке', () => {
    const other = subagent('фоновый', 'running', { background: true })
    const now = nowActivity([other, subagent('проверить сборку')], 'busy')
    expect(now).toMatchObject({ category: 'agent', verb: 'Поручил агенту', object: 'проверить сборку', objectKind: 'text' })
    expect(now?.runningAgents.map((a) => a.task)).toEqual(['фоновый'])
  })

  test('берётся самый новый работающий элемент верхнего уровня', () => {
    const nested = { ...runningTool('Bash', { command: 'ls' }), parentId: 's-parent' } as RibbonItem
    const items = [runningTool('Read', { file_path: 'C:\\a.ts' }), doneTool('Grep'), nested]
    expect(nowActivity(items, 'busy')).toMatchObject({ verb: 'Читает', object: 'a.ts' })
  })

  test('мысли и текст', () => {
    expect(nowActivity([{ kind: 'thinking', id: 'h', text: '', done: false, durationMs: 0 }], 'busy')).toMatchObject({
      category: 'thinking',
      verb: 'Думает'
    })
    expect(nowActivity([{ kind: 'agentText', id: 'x', text: 'пи', streaming: true }], 'busy')).toMatchObject({
      category: 'writing',
      verb: 'Пишет ответ'
    })
    expect(nowActivity([{ kind: 'agentText', id: 'x', text: 'всё', streaming: false }], 'busy')).toMatchObject({
      category: 'thinking',
      verb: 'Думает',
      objectKind: 'none'
    })
  })

  test.each([
    ['Glob', { pattern: '**/*.ts' }, 'read', 'Ищет файлы', '**/*.ts'],
    ['WebSearch', { query: 'vitest each' }, 'search', 'Ищет в сети', '"vitest each"'],
    ['WebFetch', { url: 'https://example.com/docs?a=1' }, 'search', 'Открывает', 'example.com'],
    ['Edit', { file_path: 'C:/p/a.ts' }, 'edit', 'Правит', 'a.ts'],
    ['MultiEdit', { file_path: 'C:/p/b.ts' }, 'edit', 'Правит', 'b.ts'],
    ['NotebookEdit', { notebook_path: 'C:/p/n.ipynb' }, 'edit', 'Правит', 'n.ipynb'],
    ['Write', { file_path: 'C:/p/c.md' }, 'edit', 'Пишет', 'c.md'],
    ['PowerShell', { command: 'Get-ChildItem' }, 'command', 'Запускает', 'Get-ChildItem'],
    ['Agent', { description: 'найти баг' }, 'agent', 'Поручил агенту', 'найти баг'],
    ['mcp__github__search_code', {}, 'mcp', 'MCP', 'github · search_code'],
    ['TodoWrite', { todos: [] }, 'plan', 'Обновляет план', ''],
    ['Frobnicate', {}, 'other', 'Вызывает', 'Frobnicate']
  ] as const)('%s', (name, input, category, verb, object) => {
    expect(nowActivity([runningTool(name, input)], 'busy')).toMatchObject({ category, verb, object })
  })

  test('без входа — цель карточки', () => {
    const item = runningTool('Read', {}, 'C:\\p\\old.ts')
    delete (item as { input?: unknown }).input
    expect(nowActivity([item], 'busy')).toMatchObject({ verb: 'Читает', object: 'old.ts', path: 'C:\\p\\old.ts' })
  })
})
