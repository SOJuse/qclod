import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('экран загрузки и марка', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8')

  test('index.html: разметка загрузки лежит внутри #root', () => {
    const root = /<div id="root">([\s\S]*?)<\/div>\s*<script/.exec(html)
    expect(root).not.toBeNull()
    expect(root![1]).toContain('data-testid="boot"')
    expect(root![1]).toContain('role="status"')
    expect(root![1]).toContain('aria-label="Qclod запускается"')
    expect(root![1]).toContain('src="./assets/mark.svg"')
  })

  test('index.html подключает boot.css', () => {
    expect(html).toMatch(/<link[^>]+href="\.\/styles\/boot\.css"/)
  })

  test('boot.css: без цветовых литералов и градиентов, дыхание отключается при reduced-motion', () => {
    const css = readFileSync('src/renderer/styles/boot.css', 'utf8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|gradient|backdrop-filter/)
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/)
  })

  test('mark.svg окна побайтно равен мастеру build/brand/qclod.svg', () => {
    expect(readFileSync('src/renderer/assets/mark.svg').equals(readFileSync('build/brand/qclod.svg'))).toBe(true)
  })
})
