import { describe, expect, test } from 'vitest'
import type { RibbonItem } from '../../src/shared/types'
import { agentNodes, elapsedMs, nodesKey } from '../../src/renderer/agents/agentModel'

type Sub = Extract<RibbonItem, { kind: 'subagent' }>
const sub = (id: string, patch: Partial<Sub> = {}): Sub => ({
  kind: 'subagent',
  id,
  toolUseId: `tu-${id}`,
  name: 'Explore',
  task: `задача ${id}`,
  state: 'done',
  summary: '',
  ...patch
})
const tool = (id: string, parentId?: string): RibbonItem => ({
  kind: 'tool',
  id,
  toolUseId: `tu-${id}`,
  name: 'SendMessage',
  target: '',
  summary: '',
  detail: '',
  state: 'done',
  ...(parentId ? { parentId } : {})
})

describe('agentNodes', () => {
  test('порядок ленты; вложенный агент — parentId родителя и depth 2', () => {
    const nodes = agentNodes([
      sub('a'),
      tool('t1', 'a'),
      sub('b', { parentId: 'a' }),
      { kind: 'agentText', id: 'x', text: 'hi', streaming: false },
      sub('c')
    ])
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(nodes[0]).toMatchObject({ parentId: null, depth: 1 })
    expect(nodes[1]).toMatchObject({ parentId: 'a', depth: 2 })
    expect(nodes[2]).toMatchObject({ parentId: null, depth: 1 })
  })

  test('ближайший предок-subagent ищется сквозь вызовы инструментов', () => {
    const nodes = agentNodes([sub('a'), tool('t', 'a'), sub('b', { parentId: 't' })])
    expect(nodes[1]).toMatchObject({ parentId: 'a', depth: 2 })
  })

  test('parentId на не-subagent (вызов SendMessage) — parentId: null', () => {
    const nodes = agentNodes([tool('send'), sub('a', { parentId: 'send' })])
    expect(nodes[0]).toMatchObject({ parentId: null, depth: 1 })
  })

  test('runs по умолчанию 1; поля карточки переходят в узел', () => {
    const [a, b] = agentNodes([
      sub('a', { background: true, tokens: 1200, toolCalls: 3, model: 'claude-haiku-5-5', startedAt: 5, endedAt: 9 }),
      sub('b', { runs: 2 })
    ])
    expect(a).toMatchObject({
      runs: 1,
      background: true,
      tokens: 1200,
      toolCalls: 3,
      model: 'claude-haiku-5-5',
      startedAt: 5,
      endedAt: 9,
      name: 'Explore',
      task: 'задача a'
    })
    expect(b!.runs).toBe(2)
    expect(b!.background).toBe(false)
  })

  test('работающий без сводки показывает последний инструмент (проба: summary приходит не сразу)', () => {
    const [a, b] = agentNodes([
      sub('a', { state: 'running', lastTool: 'Bash' }),
      sub('b', { state: 'running', summary: 'читает файлы', lastTool: 'Read' })
    ])
    expect(a!.summary).toBe('Bash')
    expect(b!.summary).toBe('читает файлы')
  })
})

describe('elapsedMs', () => {
  const [node] = agentNodes([sub('a')])
  test('работающий — now - startedAt', () => {
    expect(elapsedMs({ ...node!, state: 'running', startedAt: 1000 }, 4500)).toBe(3500)
  })
  test('законченный — durationMs, иначе endedAt - startedAt', () => {
    expect(elapsedMs({ ...node!, startedAt: 1000, endedAt: 3000, durationMs: 2500 }, 9e9)).toBe(2500)
    expect(elapsedMs({ ...node!, startedAt: 1000, endedAt: 3000 }, 9e9)).toBe(2000)
    expect(elapsedMs({ ...node!, startedAt: 0, endedAt: 3000 }, 9e9)).toBe(3000)
  })
  test('без времени — null', () => {
    expect(elapsedMs(node!, 9e9)).toBeNull()
    expect(elapsedMs({ ...node!, state: 'running' }, 9e9)).toBeNull()
  })
})

describe('nodesKey', () => {
  test('меняется с состоянием и родителем, не меняется с временем и сводкой', () => {
    const a = agentNodes([sub('a', { state: 'running' }), sub('b', { parentId: 'a' })])
    const same = agentNodes([sub('a', { state: 'running', summary: 'иначе', tokens: 9 }), sub('b', { parentId: 'a' })])
    const done = agentNodes([sub('a'), sub('b', { parentId: 'a' })])
    expect(nodesKey(same)).toBe(nodesKey(a))
    expect(nodesKey(done)).not.toBe(nodesKey(a))
  })
})
