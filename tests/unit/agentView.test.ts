import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { CostRates, RibbonItem } from '../../src/shared/types'
import { AgentView } from '../../src/renderer/components/agents/AgentView'
import { AgentMessage } from '../../src/renderer/components/agents/AgentMessage'
import { RibbonRow } from '../../src/renderer/components/RibbonItem'

type Sub = Extract<RibbonItem, { kind: 'subagent' }>
type Msg = Extract<RibbonItem, { kind: 'agentMessage' }>
const card = (patch: Partial<Sub> = {}): Sub => ({
  kind: 'subagent',
  id: 'a',
  toolUseId: 'tu-a',
  name: 'Explore',
  task: 'Найти конфиг сборки',
  state: 'running',
  summary: '',
  tokens: 42_100,
  toolCalls: 3,
  model: 'claude-haiku-5-5',
  ...patch
})
const rates: CostRates = { byModel: { 'claude-haiku-5-5': 0.000001 }, average: 0.000002 }
const msg = (patch: Partial<Msg> = {}): Msg => ({
  kind: 'agentMessage',
  id: 'm1',
  parentId: 'a',
  from: 'person',
  text: 'Посмотри ещё в tests/',
  state: 'sent',
  ...patch
})

const view = (c: Sub, items: RibbonItem[] = [c], costRates: CostRates | null = rates): string =>
  renderToStaticMarkup(createElement(AgentView, { tabId: 't', card: c, items, costRates, onBack: () => undefined }))

describe('AgentView', () => {
  test('назад: «Все агенты» с aria-label «Назад ко всем агентам»', () => {
    const html = view(card())
    expect(html).toContain('aria-label="Назад ко всем агентам"')
    expect(html).toContain('Все агенты')
  })

  test('работающий — есть «Остановить», законченный — нет', () => {
    expect(view(card())).toContain('data-testid="agent-stop"')
    expect(view(card())).toContain('Остановить')
    expect(view(card({ state: 'done' }))).not.toContain('data-testid="agent-stop"')
  })

  test('шапка: тип, задача, состояние; подробности — токены, ≈ $, вызовы, модель', () => {
    const html = view(card({ state: 'done', durationMs: 4200 }))
    expect(html).toContain('Explore')
    expect(html).toContain('Найти конфиг сборки')
    expect(html).toContain('готов')
    expect(html).toContain('4,2 с')
    const details = /data-testid="agent-details"[^>]*>([^<]*)</.exec(html)?.[1] ?? ''
    expect(details).toBe('42k токенов · ≈ $0.0421 · 3 вызова · claude-haiku-5-5')
  })

  test('без ставок — «стоимость неизвестна»', () => {
    const html = view(card(), [card()], null)
    expect(html).toContain('стоимость неизвестна')
    expect(html).not.toContain('≈ $')
  })

  test('«Задача от главного агента» — свёрнутый <details> при prompt, без prompt его нет', () => {
    const html = view(card({ prompt: 'Найди, где **читается** конфиг' }))
    expect(html).toMatch(/<details[^>]*class="agent-prompt"/)
    expect(html).not.toMatch(/<details[^>]*class="agent-prompt"[^>]*\sopen/)
    expect(html).toContain('Задача от главного агента')
    expect(html).toMatch(/<strong>(<span>)?читается/)
    expect(view(card())).not.toContain('Задача от главного агента')
  })

  test('лента — только своё: сообщение от человека в passed — «передано» и «через главного агента»', () => {
    const c = card()
    const html = view(c, [
      { kind: 'agentText', id: 'main', text: 'ГЛАВНЫЙ ТЕКСТ', streaming: false },
      c,
      { kind: 'agentText', id: 'own', parentId: 'a', text: 'СВОЙ ТЕКСТ', streaming: false },
      msg({ state: 'passed' })
    ])
    expect(html).toContain('СВОЙ ТЕКСТ')
    expect(html).not.toContain('ГЛАВНЫЙ ТЕКСТ')
    expect(html).toContain('передано')
    expect(html).toContain('через главного агента')
  })
})

describe('AgentMessage', () => {
  const html = (m: Msg): string => renderToStaticMarkup(createElement(AgentMessage, { item: m }))

  test('от человека: справа, «через главного агента» и состояние', () => {
    const states: Array<[Msg['state'], string]> = [
      ['sent', 'ждёт главного агента'],
      ['read', 'главный агент прочитал'],
      ['passed', 'передано'],
      ['cancelled', 'не передано']
    ]
    for (const [state, word] of states) {
      const out = html(msg({ state }))
      expect(out).toContain('is-person')
      expect(out).toContain('через главного агента')
      expect(out).toContain(word)
    }
  })

  test('от главного: слева, «от главного агента»', () => {
    const out = html(msg({ from: 'main', text: 'Проверь ещё README' }))
    expect(out).toContain('is-main')
    expect(out).toContain('от главного агента')
    expect(out).toContain('Проверь ещё README')
    expect(out).not.toContain('через главного агента')
  })
})

describe('главная лента: пузырь user с relay', () => {
  const row = (item: RibbonItem): string =>
    renderToStaticMarkup(
      createElement(RibbonRow, {
        item,
        byParent: new Map(),
        cwd: 'C:\\p',
        tabId: 't',
        onMeasure: () => undefined,
        answers: { permission: () => undefined, question: () => undefined, plan: () => undefined }
      })
    )

  test('с relay — «агенту Explore:» со стрелкой-значком перед текстом', () => {
    const out = row({ kind: 'user', id: 'u', text: 'глянь tests/', attachments: [], relay: { cardId: 'a', agent: 'Explore' } })
    expect(out).toContain('data-testid="user-relay"')
    expect(out).toMatch(/<svg[^>]*lucide-arrow-right[^]*агенту Explore:/)
    expect(out.indexOf('агенту Explore:')).toBeLessThan(out.indexOf('глянь tests/'))
  })

  test('без relay — префикса нет', () => {
    expect(row({ kind: 'user', id: 'u', text: 'привет', attachments: [] })).not.toContain('агенту')
  })

  test('agentMessage рисуется своей строкой', () => {
    expect(row(msg({ parentId: undefined }))).toContain('через главного агента')
  })
})
