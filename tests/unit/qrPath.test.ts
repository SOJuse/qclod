import { expect, test } from 'vitest'
import { qrMatrix, qrPath } from '../../src/renderer/panel/qrPath'

test('qrPath рисует только тёмные клетки', () => {
  expect(qrPath([[true, false], [false, true]])).toBe('M0 0h1v1h-1zM1 1h1v1h-1z')
})
test('матрица ссылки — квадрат версии не меньше 1 с рамкой', () => {
  const m = qrMatrix('https://claude.ai/code/session_fake0001')
  expect(m.length).toBeGreaterThanOrEqual(21 + 8)
  expect(m.every((row) => row.length === m.length)).toBe(true)
  expect(m[0]!.every((cell) => cell === false)).toBe(true) // рамка светлая
})
test('светлая рамка — четыре клетки с каждой стороны, как требует стандарт', () => {
  const m = qrMatrix('https://claude.ai/code/session_fake0001')
  const n = m.length
  for (let i = 0; i < 4; i++) {
    expect(m[i]!.every((c) => !c)).toBe(true)
    expect(m[n - 1 - i]!.every((c) => !c)).toBe(true)
    expect(m.every((row) => !row[i] && !row[n - 1 - i])).toBe(true)
  }
  // за рамкой сразу начинается узор поиска — тёмный угол
  expect(m[4]![4]).toBe(true)
})
