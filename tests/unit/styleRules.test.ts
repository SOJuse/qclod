import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { rendererCssFiles, stripComments } from './cssTokens'

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
