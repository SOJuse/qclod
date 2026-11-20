import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { SidePanel } from '../../src/renderer/components/SidePanel'
import { EMPTY_PANEL } from '../../src/renderer/state/useAppStore'
import { REMOTE_OFF } from '../../src/shared/remote'
import type { McpServerInfo, PanelData } from '../../src/shared/types'

const noop = (): void => undefined
const render = (patch: Partial<PanelData> = {}, mode: 'docked' | 'drawer' = 'docked'): string =>
  renderToStaticMarkup(
    createElement(SidePanel, {
      data: { ...EMPTY_PANEL, ...patch },
      started: true,
      remote: REMOTE_OFF,
      onRemote: noop,
      mode,
      onClose: noop
    })
  )

const headings = (html: string): string[] => [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((m) => m[1]!)
const testIdText = (html: string, id: string): string => {
  const m = html.match(new RegExp(`data-testid="${id}"[^>]*>(.*?)</`))
  return m ? m[1]!.replace(/<[^>]+>/g, '') : ''
}

describe('SidePanel', () => {
  test('порядок заголовков разделов ровно «Контекст, Лимиты, MCP, Remote Control»', () => {
    expect(headings(render())).toEqual(['Контекст', 'Лимиты', 'MCP', 'Remote Control'])
  })

  test('3 подключённых и 1 упавший: упавший виден, подключённые свёрнуты в «3 подключено»', () => {
    const mcp: McpServerInfo[] = [
      { name: 'первый', status: 'connected' },
      { name: 'сломанный', status: 'failed' },
      { name: 'второй', status: 'connected' },
      { name: 'третий', status: 'connected' }
    ]
    const html = render({ mcp })
    expect(html).toContain('сломанный')
    const ok = html.match(/data-testid="panel-mcp-ok"[^>]*>([^]*?)<\/button>/)?.[1] ?? ''
    expect(ok.replace(/<[^>]+>/g, '')).toBe('3 подключено')
    // Folded: the connected ones are not listed until the line is clicked.
    expect(html).not.toContain('первый')
    expect(html).toContain('aria-expanded="false"')
  })

  test('упавшие, требующие входа и подключающиеся — до подключённых', () => {
    const mcp: McpServerInfo[] = [
      { name: 'вход', status: 'needs-auth' },
      { name: 'жду', status: 'connecting' },
      { name: 'упал', status: 'failed' }
    ]
    const html = render({ mcp: [{ name: 'ок', status: 'connected' }, ...mcp] })
    const at = (name: string): number => html.indexOf(`>${name}<`)
    expect(at('упал')).toBeGreaterThan(-1)
    expect(at('упал')).toBeLessThan(at('вход'))
    expect(at('вход')).toBeLessThan(at('жду'))
    expect(html.indexOf('data-testid="panel-mcp-ok"')).toBeGreaterThan(at('жду'))
  })

  test('раздела агентов больше нет', () => {
    const html = render()
    expect(html).not.toContain('panel-agents')
    expect(html).not.toContain('Агенты')
  })

  test('строка «Сессия»: модель, стоимость и «Настройки проекта: N хуков»', () => {
    const html = render({
      model: 'claude-opus-5',
      models: [{ value: 'claude-opus-5', displayName: 'Opus 5', description: '' }],
      cost: { session: 0.1234, sinceOpen: false },
      projectSettings: { hooks: 2, mcpServers: [] }
    })
    expect(html).toContain('data-testid="panel-session"')
    expect(testIdText(html, 'panel-model')).toBe('Opus 5')
    expect(html).toMatch(/data-testid="panel-cost"[^>]*>[^]*\$0\.1234/)
    expect(html).toContain('Настройки проекта: 2 хука')
    // The session row closes the panel: it is not one of the sections.
    expect(html.indexOf('data-testid="panel-session"')).toBeGreaterThan(html.indexOf('data-testid="panel-remote"'))
  })

  test('лимиты — в разделе «Лимиты», с подписью сброса', () => {
    const now = Math.floor(Date.now() / 1000)
    const html = render({
      limits: { fiveHour: { utilization: 0.13, resetsAt: now + 7200 }, sevenDay: { utilization: 0.38, resetsAt: now + 400000 } }
    })
    expect(html).toMatch(/data-testid="panel-limits"[^]*13%[^]*38%/)
  })

  test('выдвинутая панель помечена data-mode="drawer", кнопки закрытия своей не держит', () => {
    expect(render({}, 'drawer')).toContain('data-mode="drawer"')
    expect(render({}, 'docked')).toContain('data-mode="docked"')
    // The pane's header holds the one panel button.
    expect(render()).not.toContain('data-testid="panel-close"')
  })
})
