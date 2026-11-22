import { expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QuitReason, sessionEnding } from '../../src/main/system/quitReason'

test('по умолчанию выход намеренный; после markInterrupted — нет', () => {
  const r = new QuitReason()
  expect(r.deliberate).toBe(true)
  r.markInterrupted()
  expect(r.deliberate).toBe(false)
  r.markInterrupted()
  expect(r.deliberate).toBe(false)
})

test('конец сеанса Windows: выход не намеренный, и ядра замораживаются сразу — before-quit может не прийти', () => {
  const r = new QuitReason()
  const quitting = vi.fn()
  sessionEnding(r, { quitting })
  expect(r.deliberate).toBe(false)
  // working stays for the next start (decision 8).
  expect(quitting).toHaveBeenCalledWith(false)

  const src = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8')
  expect(src).toContain("on('session-end', () => sessionEnding(quitReason, autonomy))")
})
