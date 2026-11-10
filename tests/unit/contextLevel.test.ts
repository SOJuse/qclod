import { expect, test } from 'vitest'
import { contextLevel } from '../../src/renderer/chat/contextLevel'

test.each([
  [79, 'ok'],
  [80, 'warn'],
  [89, 'warn'],
  [90, 'critical'],
  [100, 'critical']
])('%i%% → %s', (p, l) => expect(contextLevel(p)).toBe(l))

test('дробный процент на пороге уже меняет уровень', () => {
  expect(contextLevel(79.9)).toBe('ok')
  expect(contextLevel(89.5)).toBe('warn')
})
