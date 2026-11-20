import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

const html = readFileSync(resolve(__dirname, '../../src/renderer/fallback.html'), 'utf8')
const css = readFileSync(resolve(__dirname, '../../src/renderer/styles/fallback.css'), 'utf8')

test('the page names the three ways out by test id and exact text', () => {
  expect(html).toMatch(/data-testid="fallback-retry"[^>]*>\s*Попробовать снова\s*</)
  expect(html).toMatch(/data-testid="fallback-logs"[^>]*>\s*Открыть журнал\s*</)
  expect(html).toMatch(/data-testid="fallback-close"[^>]*>\s*Закрыть окно\s*</)
})

test('heading and explanation are the agreed words', () => {
  expect(html).toContain('Окно Qclod не запускается')
  expect(html).toContain(
    'Окно трижды перезагрузилось и снова упало. Агенты в чатах продолжают работать — с ними ничего не случилось.'
  )
})

test('no inline script: every <script> only has a src', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  expect(scripts.length).toBeGreaterThan(0)
  for (const [, attrs, body] of scripts) {
    expect(attrs).toMatch(/\bsrc="/)
    expect(body.trim()).toBe('')
  }
})

test('the page does not load the renderer bundle: no main.tsx, no React', () => {
  expect(html).not.toContain('main.tsx')
  expect(html).toContain('fallback.ts')
})

test('the title bar drags the window and the buttons do not', () => {
  expect(css).toMatch(/-webkit-app-region:\s*drag/)
  expect(css).toMatch(/-webkit-app-region:\s*no-drag/)
  expect(html).toContain('Qclod')
})

test('the styles bring the tokens in themselves, as a source file, not through the bundle', () => {
  expect(css).toMatch(/@import\s+['"]\.\/tokens\.css['"]/)
})
