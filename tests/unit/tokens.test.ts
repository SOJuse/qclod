import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { contrast, deltaE, mix, readTokens, resolveColor } from './cssTokens'

const css = readFileSync(resolve(__dirname, '../../src/renderer/styles/tokens.css'), 'utf8')
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'))

test('у каждой категории есть цветовой токен', () => {
  for (const c of ['read', 'search', 'edit', 'command', 'agent', 'mcp', 'plan', 'other']) {
    expect(css).toMatch(new RegExp(`--cat-${c}:`))
  }
})

test('статусные цвета, трек, сегменты, шкала шрифта и отступов на месте', () => {
  for (const t of ['--status-ok', '--status-warn', '--status-critical', '--meter-track',
    '--seg-1', '--seg-2', '--seg-3', '--seg-4', '--seg-5', '--seg-6', '--seg-free', '--seg-buffer', '--font-ui',
    '--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl',
    '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--rule-category',
    '--gap-hair', '--radius-pill']) {
    expect(css).toContain(`${t}:`)
  }
})

test('значения токенов совпадают с таблицей', () => {
  expect(css).toContain('--gap-hair: 2px')
  expect(css).toContain('--radius-pill: 999px')
  expect(css).toContain('--cat-plan: var(--accent)')
  expect(css).toContain('--cat-other: var(--text-faint)')
})

test('колонка чата и размеры раскладки этапа 2', () => {
  expect(css).toContain('--content-max-w: 800px')
  expect(css).toContain('--sidebar-w: 260px')
  expect(css).toContain('--pane-min-w: 320px')
  expect(css).toContain('--panel-w: 280px')
})

test('при prefers-reduced-motion: reduce переходы и анимации выключены', () => {
  const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\})\s*\}/.exec(css)?.[1] ?? ''
  expect(block).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/)
  expect(block).toMatch(/transition-duration:\s*0s !important/)
  expect(block).toMatch(/animation-duration:\s*0s !important/)
})

test('lucide-react закреплён точной версией', () => {
  expect(pkg.dependencies['lucide-react']).toBe('1.62.0')
})

const t = readTokens(css)
const SURFACES = ['--bg', '--surface', '--surface-raised']
const TEXTISH = ['--text', '--text-dim', '--text-faint', '--accent',
  '--cat-read', '--cat-search', '--cat-edit', '--cat-command', '--cat-agent', '--cat-mcp', '--cat-plan', '--cat-other',
  '--status-ok', '--status-warn', '--status-critical']

test('поверхности — непрозрачные ступени из спеки', () => {
  expect(resolveColor(t, '--bg')).toBe('#0f0f11')
  expect(resolveColor(t, '--surface')).toBe('#16161a')
  expect(resolveColor(t, '--surface-raised')).toBe('#1d1d22')
  expect(resolveColor(t, '--surface-hover')).toBe('#26262d')
})

test.each(TEXTISH.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))('%s на %s — не меньше 4.5:1', (fg, bg) => {
  expect(contrast(resolveColor(t, fg), resolveColor(t, bg))).toBeGreaterThanOrEqual(4.5)
})

test.each([['--text', '--surface-hover'], ['--text-dim', '--surface-hover'], ['--text-faint', '--surface-hover'], ['--on-accent', '--accent']])(
  '%s на %s — не меньше 4.5:1', (fg, bg) => expect(contrast(resolveColor(t, fg), resolveColor(t, bg))).toBeGreaterThanOrEqual(4.5))

test.each(['--syn-keyword', '--syn-string', '--syn-number', '--syn-type', '--syn-comment', '--syn-punct'])(
  'подсветка %s читается на фоне кода', (n) => expect(contrast(resolveColor(t, n), resolveColor(t, '--bg'))).toBeGreaterThanOrEqual(4.5))

test.each(['--status-ok', '--status-warn', '--status-critical', '--text-dim'])('заливка %s видна на треке (≥ 3:1)', (n) => {
  expect(contrast(resolveColor(t, n), resolveColor(t, '--meter-track'))).toBeGreaterThanOrEqual(3)
})

test('цветные категории различимы попарно (ΔE OKLab ≥ 15), агент далеко от плана', () => {
  const cats = ['search', 'edit', 'command', 'agent', 'mcp', 'plan'].map((c) => resolveColor(t, `--cat-${c}`))
  for (let i = 0; i < cats.length; i++) for (let j = i + 1; j < cats.length; j++) {
    expect(deltaE(cats[i], cats[j])).toBeGreaterThanOrEqual(15)
  }
})

test('шкала шрифта — ровно шесть ступеней', () => {
  const sizes = [...t].filter(([k, v]) => k.startsWith('--text-') && /px$/.test(v))
  expect(Object.fromEntries(sizes)).toEqual({
    '--text-xs': '11px', '--text-sm': '12px', '--text-md': '13px',
    '--text-lg': '14px', '--text-xl': '16px', '--text-2xl': '20px'
  })
})

test('шрифты закреплены точными версиями и лежат в пакетах', () => {
  expect(pkg.dependencies['@fontsource-variable/inter']).toBe('5.3.0')
  expect(pkg.dependencies['@fontsource-variable/geist-mono']).toBe('5.3.0')
  expect(css).not.toMatch(/@font-face/) // шрифты приходят из пакетов
  expect(t.get('--font-ui')).toMatch(/^'Inter Variable'/)
  expect(t.get('--font-mono')).toMatch(/^'Geist Mono Variable'/)
})

test('старых токенов стекла больше нет', () => {
  for (const n of ['--glow', '--glow-accent', '--glow-soft', '--menu-blur', '--surface-sunken', '--now-max-w', '--now-gutter', '--ok', '--warn', '--danger']) {
    expect(t.has(n)).toBe(false)
  }
})

test('тонированные заливки — непрозрачная смесь над --surface-raised', () => {
  const fills = [...t].filter(([k]) => /-fill(-strong)?$/.test(k) && k !== '--hover-fill')
  expect(fills.map(([k]) => k).sort()).toEqual(['--accent-fill', '--accent-fill-strong', '--critical-fill', '--warn-fill'])
  for (const [, v] of fills) expect(v).toMatch(/^color-mix\(in srgb, var\(--[\w-]+\) \d+%, var\(--surface-raised\)\)$/)
})

test('интерфейс по умолчанию — Inter, ступень md, межстрочный интерфейса', () => {
  const body = /\nbody\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  expect(body).toMatch(/font-family:\s*var\(--font-ui\)/)
  expect(body).toMatch(/font-size:\s*var\(--text-md\)/)
  expect(body).toMatch(/line-height:\s*var\(--leading\)/)
})

test('чип категории: значок читается на своей тонировке (≥ 3:1)', () => {
  expect(mix('#ffffff', '#000000', 50)).toBe('#808080')
  const tint = parseFloat(t.get('--tool-chip-tint') ?? '')
  expect(tint).toBeGreaterThan(0)
  // A chip sits on a card (--surface-raised), in the «now» line (--surface) and on a hovered head (--surface-hover).
  const icons = ['read', 'search', 'edit', 'command', 'agent', 'mcp', 'plan', 'other'].map((c) => `--cat-${c}`).concat('--status-critical')
  for (const icon of icons) for (const surface of ['--surface-raised', '--surface', '--surface-hover']) {
    const fg = resolveColor(t, icon)
    expect(contrast(fg, mix(fg, resolveColor(t, surface), tint)), `${icon} на ${surface}`).toBeGreaterThanOrEqual(3)
  }
})
