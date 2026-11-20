import { expect, test, vi } from 'vitest'
import { claimSingleInstance } from '../../src/main/system/singleInstance'

function fakeApp(lock: boolean) {
  const handlers = new Map<string, () => void>()
  return {
    handlers,
    requestSingleInstanceLock: vi.fn(() => lock),
    on: vi.fn((event: string, cb: () => void) => void handlers.set(event, cb)),
    quit: vi.fn()
  }
}

test('второй экземпляр: замок не взят — quit, true не возвращается', () => {
  const app = fakeApp(false)
  const onSecond = vi.fn()
  expect(claimSingleInstance(app as never, onSecond)).toBe(false)
  expect(app.quit).toHaveBeenCalledTimes(1)
  expect(app.handlers.has('second-instance')).toBe(false)
  expect(onSecond).not.toHaveBeenCalled()
})

test('first instance keeps running; second-instance зовёт onSecond', () => {
  const app = fakeApp(true)
  const onSecond = vi.fn()
  expect(claimSingleInstance(app as never, onSecond)).toBe(true)
  expect(app.quit).not.toHaveBeenCalled()
  app.handlers.get('second-instance')!()
  expect(onSecond).toHaveBeenCalledTimes(1)
})
