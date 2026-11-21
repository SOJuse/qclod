import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { CostRates, RibbonItem } from '../../src/shared/types'
import { AgentsLayer } from '../../src/renderer/components/agents/AgentsLayer'

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
const rates: CostRates = { byModel: { 'claude-haiku-5-5': 0.000001 }, average: 0.000002 }

const render = (items: RibbonItem[], costRates: CostRates | null = rates): string =>
  renderToStaticMarkup(createElement(AgentsLayer, { tabId: 't', items, costRates }))
const count = (html: string, needle: string): number => html.split(needle).length - 1

describe('AgentsLayer', () => {
  test('пустой слой — «В этом чате ещё не было сабагентов» с подсказкой', () => {
    const html = render([{ kind: 'agentText', id: 'x', text: 'привет', streaming: false }])
    expect(html).toContain('В этом чате ещё не было сабагентов')
    expect(html).toContain('Они появятся здесь, когда главный агент их запустит.')
    expect(html).not.toContain('data-testid="agent-node"')
  })

  test('три узла: «Главный агент», три agent-node, is-running, «фон», «запуск 2»', () => {
    const html = render([
      sub('a', { state: 'running', startedAt: Date.now() - 3000 }),
      sub('b', { background: true }),
      sub('c', { runs: 2 })
    ])
    expect(html).toContain('Главный агент')
    expect(count(html, 'data-testid="agent-node"')).toBe(3)
    expect(count(html, 'is-running')).toBe(1)
    expect(html).toMatch(/data-state="running"[^>]*>|class="[^"]*is-running[^"]*"[^>]*data-state="running"/)
    expect(html).toContain('фон')
    expect(html).toContain('запуск 2')
    expect(html).not.toContain('запуск 1')
  })

  test('шапка: счётчик и переключатель «Граф» / «Таймлайн»', () => {
    const html = render([sub('a', { state: 'running' }), sub('b')])
    expect(html).toContain('работают: 1 · всего: 2')
    expect(html).toContain('role="tablist"')
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Граф</)
    expect(html).toContain('Таймлайн')
  })

  test('title узла: тип, токены, ≈ $, вызовы', () => {
    const html = render([sub('a', { tokens: 42_100, toolCalls: 3, model: 'claude-haiku-5-5' })])
    const title = /data-testid="agent-node"[^>]*title="([^"]*)"|title="([^"]*)"[^>]*data-testid="agent-node"/.exec(html)
    const text = title?.[1] ?? title?.[2] ?? ''
    expect(text).toContain('Explore')
    expect(text).toContain('токенов')
    expect(text).toContain('≈ $0.0421')
    expect(text).toContain('3 вызова')
  })

  test('связи: у работающего ребёнка — is-live', () => {
    const html = render([sub('a', { state: 'running' }), sub('b')])
    expect(count(html, 'agent-edge is-live')).toBe(1)
    expect(count(html, 'class="agent-edge"')).toBe(1)
  })

  test('в узле — задача, слово состояния и время', () => {
    const html = render([sub('a', { durationMs: 4200 })])
    expect(html).toContain('задача a')
    expect(html).toContain('готов')
    expect(html).toContain('4,2 с')
  })
})
