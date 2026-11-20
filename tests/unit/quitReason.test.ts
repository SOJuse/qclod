import { expect, test } from 'vitest'
import { QuitReason } from '../../src/main/system/quitReason'

test('по умолчанию выход намеренный; после markInterrupted — нет', () => {
  const r = new QuitReason()
  expect(r.deliberate).toBe(true)
  r.markInterrupted()
  expect(r.deliberate).toBe(false)
  r.markInterrupted()
  expect(r.deliberate).toBe(false)
})
