import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { rendererCssFiles, rendererTsxFiles, stripComments } from './cssTokens'

const root = resolve(__dirname, '../..')

const files = rendererCssFiles().map((f) => [f, stripComments(readFileSync(f, 'utf8'))] as const)
const hits = (re: RegExp) => files.flatMap(([f, src]) => [...src.matchAll(re)].map((m) => `${f}: ${m[0]}`))

// `(?!\s)` stops `\s*` from backtracking to zero and letting the lookahead pass on the space.
test('размер шрифта — только ступени шкалы', () => {
  expect(hits(/font-size:\s*(?!\s)(?!var\(--text-(xs|sm|md|lg|xl|2xl)\))[^;]+/g)).toEqual([])
})
test('межстрочный — только токены', () => {
  expect(hits(/line-height:\s*(?!\s)(?!var\(--leading)(?!1;)[^;]+/g)).toEqual([])
})
test('никакого капса и разрядки', () => {
  expect(hits(/text-transform:\s*uppercase/g)).toEqual([])
  expect(hits(/letter-spacing:\s*[^;]+/g)).toEqual([])
})
test('вес — только токены', () => {
  expect(hits(/font-weight:\s*(?!\s)(?!var\(--weight-)[^;]+/g)).toEqual([])
})

// The colour words must stand alone: `white-space` is not a colour.
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(white|black)\b(?![-\w])/g
test('правило цветовых литералов ловит литералы и не трогает white-space', () => {
  const sample = 'color: #0c0f1c; background: rgba(0, 0, 0, 0.5); border-color: white; white-space: nowrap; --text-faint: x;'
  expect([...sample.matchAll(COLOUR_LITERAL)].map((m) => m[0])).toEqual(['#0c0f1c', 'rgba(', 'white'])
})
test('в CSS компонентов нет цветовых литералов', () => {
  expect(hits(COLOUR_LITERAL)).toEqual([])
})
test('нет свечения и декоративных градиентов', () => {
  expect(hits(/--glow|linear-gradient|radial-gradient|backdrop-filter/g)).toEqual([])
})
test('нет удалённых алиасов Task 1', () => {
  expect(hits(/var\(--(surface-sunken|menu-blur|now-max-w|now-gutter|ok|warn|danger)\)/g)).toEqual([])
})
test('в TSX нет инлайн-цветов', () => {
  const tsx = rendererTsxFiles().flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/['"`]#[0-9a-fA-F]{3,8}['"`]|rgba?\(/g)].map((m) => `${f}: ${m[0]}`))
  expect(tsx).toEqual([])
})
test('ширина колонки чата — один токен (NowLine и предупреждение о закрытии)', () => {
  const chat = readFileSync(resolve(root, 'src/renderer/components/ChatPane.css'), 'utf8')
  expect(chat).not.toMatch(/920px/)
  expect(chat).toContain('var(--content-max-w)')
  const now = readFileSync(resolve(root, 'src/renderer/components/NowLine.css'), 'utf8')
  expect(now).toContain('var(--content-max-w)')
  expect(now).toContain('var(--content-gutter)')
})
