import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { LIMIT_ALERT, StatusLine } from '../../src/renderer/components/StatusLine'
import { EMPTY_PANEL } from '../../src/renderer/state/useAppStore'
import { REMOTE_OFF } from '../../src/shared/remote'
import type { LimitWindow, PanelData } from '../../src/shared/types'

const now = Math.floor(Date.now() / 1000)
const win = (utilization: number, inSeconds = 7200): LimitWindow => ({ utilization, resetsAt: now + inSeconds })

const render = (limits: PanelData['limits']): string =>
  renderToStaticMarkup(
    createElement(StatusLine, {
      tabId: 'a',
      data: { ...EMPTY_PANEL, limits },
      started: true,
      remote: REMOTE_OFF,
      onToggleRemote: () => undefined
    })
  )

/** The alert chip's own markup: its opening tag (with the title) and its text. */
const alert = (html: string): { tag: string; text: string } | null => {
  const tag = html.match(/<span[^>]*data-testid="status-limit-alert"[^>]*>/)?.[0]
  if (!tag) return null
  const rest = html.slice(html.indexOf(tag) + tag.length)
  const text = rest.match(/class="status-limit-text">([^]*?)<\/span>/)?.[1] ?? ''
  return { tag, text: text.replace(/<!-- -->/g, '') }
}
const decode = (s: string): string => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')

describe('StatusLine: лимиты только плашкой', () => {
  test('порог плашки — 80 %', () => expect(LIMIT_ALERT).toBe(0.8))

  test('5 часов на 50 % — плашки нет, и старых индикаторов лимитов тоже', () => {
    const html = render({ fiveHour: win(0.5), sevenDay: win(0.2) })
    expect(alert(html)).toBeNull()
    expect(html).not.toContain('status-limit-5h')
    expect(html).not.toContain('status-limit-7d')
  })

  test('5 часов на 85 % — «5 ч: 85 %», в подсказке лимит и сброс', () => {
    const chip = alert(render({ fiveHour: win(0.85), sevenDay: win(0.3) }))
    expect(chip?.text).toBe('5 ч: 85 %')
    expect(decode(chip!.tag)).toMatch(/title="Лимит на 5 часов: 85 %, сброс через 2 ч 0 мин"/)
  })

  test('неделя на 91 % и 5 часов на 85 % — показывается большее: «Неделя: 91 %»', () => {
    const chip = alert(render({ fiveHour: win(0.85), sevenDay: win(0.91, 3 * 86400) }))
    expect(chip?.text).toBe('Неделя: 91 %')
    expect(decode(chip!.tag)).toMatch(/title="Лимит на неделю: 91 %, сброс через 3 дн"/)
  })

  test('окно, чей сброс уже прошёл, плашку не даёт', () => {
    expect(alert(render({ fiveHour: win(0.95, -60), sevenDay: null }))).toBeNull()
  })

  test('без плашки лимиты всё равно доступны — в подсказке индикатора контекста', () => {
    // A split pane with its panel closed has no other place that shows them.
    const html = decode(render({ fiveHour: win(0.5), sevenDay: win(0.2, 86400) }))
    const context = html.match(/data-testid="status-context"[^>]*title="([^"]*)"/) ?? html.match(/title="([^"]*)"[^>]*data-testid="status-context"/)
    expect(context?.[1]).toContain('Лимит на 5 часов: 50 %, сброс через 2 ч 0 мин')
    expect(context?.[1]).toContain('Лимит на неделю: 20 %, сброс через 1 дн')
  })

  test('плашку лимита не прячет ни одно правило узкой строки', () => {
    const css = readFileSync(resolve(__dirname, '../../src/renderer/components/StatusLine.css'), 'utf8')
    const narrow = [...css.matchAll(/@container[^{]*\{([^]*?)\n\}/g)].map((m) => m[1]!)
    expect(narrow.length).toBeGreaterThan(0)
    for (const block of narrow) {
      for (const rule of block.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (/display:\s*none/.test(rule[2]!)) expect(rule[1]).not.toMatch(/status-limit/)
      }
    }
  })
})
