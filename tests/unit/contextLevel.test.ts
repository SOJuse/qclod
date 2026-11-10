import { expect, test } from 'vitest'
import { contextLevel } from '../../src/renderer/chat/contextLevel'

test.each([
  [79, 'ok'],
  [80, 'warn'],
  [89, 'warn'],
  [90, 'critical'],
  [100, 'critical']
])('%i%% → %s', (p, l) => expect(contextLevel(p)).toBe(l))

test('уровень считается от показанного (округлённого) процента: «90%» — всегда критично', () => {
  expect(contextLevel(79.4)).toBe('ok')
  expect(contextLevel(79.5)).toBe('warn')
  expect(contextLevel(89.4)).toBe('warn')
  expect(contextLevel(89.5)).toBe('critical')
})
