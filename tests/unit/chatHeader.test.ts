import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { ChatHeader } from '../../src/renderer/components/ChatHeader'
import { PaneLayer } from '../../src/renderer/components/PaneLayer'

type Props = Parameters<typeof ChatHeader>[0]
const noop = (): void => undefined
const render = (patch: Partial<Props> = {}): string =>
  renderToStaticMarkup(
    createElement(ChatHeader, {
      title: 'Починить вход',
      cwd: 'C:\\dev\\проект',
      status: 'busy',
      split: false,
      panelShown: true,
      onTogglePanel: noop,
      ...patch
    })
  )
const has = (html: string, id: string): boolean => html.includes(`data-testid="${id}"`)

describe('ChatHeader', () => {
  test('шапка помечена chat-header и называет состояние словом', () => {
    const html = render()
    expect(has(html, 'chat-header')).toBe(true)
    expect(html).toContain('работает')
  })

  test('без onOpenAgents кнопки «Агенты» нет', () => {
    expect(has(render({ agentsCount: 3 }), 'open-agents')).toBe(false)
  })

  test('с onOpenAgents и agentsCount 3 — «Агенты (3)», без работающих — просто «Агенты»', () => {
    const three = render({ onOpenAgents: noop, agentsCount: 3 })
    expect(three).toMatch(/data-testid="open-agents"[^>]*>[^]*Агенты \(3\)/)
    const none = render({ onOpenAgents: noop, agentsCount: 0 })
    expect(none).toMatch(/data-testid="open-agents"[^>]*>[^]*Агенты</)
    expect(none).not.toContain('Агенты (')
  })

  test('у кнопки «Агенты» есть подсказка', () => {
    const html = render({ onOpenAgents: noop, agentsCount: 1 })
    expect(/data-testid="open-agents"[^>]* title="[^"]+"|title="[^"]+"[^>]*data-testid="open-agents"/.test(html)).toBe(true)
  })

  test('pane-title — только в сплите', () => {
    expect(has(render({ split: false }), 'pane-title')).toBe(false)
    const split = render({ split: true })
    expect(has(split, 'pane-title')).toBe(true)
    expect(split).toContain('Починить вход')
  })

  test('кнопка панели: panel-close «Скрыть панель» или panel-open «Показать панель»', () => {
    expect(render({ panelShown: true })).toMatch(/data-testid="panel-close"[^>]*aria-label="Скрыть панель"|aria-label="Скрыть панель"[^>]*data-testid="panel-close"/)
    expect(render({ panelShown: false })).toMatch(/data-testid="panel-open"[^>]*aria-label="Показать панель"|aria-label="Показать панель"[^>]*data-testid="panel-open"/)
  })

  test('папка — своим именем с путём в подсказке; совпадает с названием чата — не повторяется', () => {
    const html = render({ split: true })
    expect(html).toContain('title="C:\\dev\\проект"')
    expect(html).toMatch(/class="chat-header-cwd"[^>]*>проект</)
    expect(render({ split: true, title: 'проект' })).not.toContain('chat-header-cwd')
  })

  test('«Убрать из сплита» — при onUnsplit', () => {
    expect(has(render({ split: true }), 'pane-unsplit')).toBe(false)
    expect(render({ split: true, onUnsplit: noop })).toContain('aria-label="Убрать из сплита"')
  })
})

describe('PaneLayer', () => {
  test('слой: pane-layer, заголовок, кнопка «Закрыть» pane-layer-close, фокус может встать в слой', () => {
    const html = renderToStaticMarkup(createElement(PaneLayer, { title: 'Агенты', onClose: noop, children: 'содержимое' }))
    expect(html).toContain('data-testid="pane-layer"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toMatch(/class="pane-layer-title">Агенты</)
    expect(html).toMatch(/data-testid="pane-layer-close"[^>]*aria-label="Закрыть"|aria-label="Закрыть"[^>]*data-testid="pane-layer-close"/)
    expect(html).toContain('содержимое')
  })
})
