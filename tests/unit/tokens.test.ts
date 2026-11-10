import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

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

test('lucide-react закреплён точной версией', () => {
  expect(pkg.dependencies['lucide-react']).toBe('1.62.0')
})
