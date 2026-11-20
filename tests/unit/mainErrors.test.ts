import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import { installMainErrorHandlers } from '../../src/main/system/mainErrors'
import type { ErrorEntry } from '../../src/main/system/errorLog'

function setup(): { proc: EventEmitter; log: ErrorEntry[] } {
  const proc = new EventEmitter()
  const log: ErrorEntry[] = []
  installMainErrorHandlers(proc as never, (e) => log.push(e))
  return { proc, log }
}

test('uncaughtExceptionMonitor: a record from main with message and stack', () => {
  const { proc, log } = setup()
  const err = new Error('boom')
  proc.emit('uncaughtExceptionMonitor', err)
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({ source: 'main', message: 'boom', stack: err.stack })
})

test('unhandledRejection with an Error: written with its stack', () => {
  const { proc, log } = setup()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  proc.emit('unhandledRejection', new Error('nope'))
  expect(log[0]).toMatchObject({ source: 'main', message: 'nope' })
  expect(log[0]!.stack).toContain('nope')
})

test('a rejection whose toString throws is still written, and nothing escapes', () => {
  const { proc, log } = setup()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const hostile = {
    toString() {
      throw 1
    }
  }
  expect(() => proc.emit('unhandledRejection', hostile)).not.toThrow()
  expect(log).toHaveLength(1)
  expect(log[0]!.source).toBe('main')
})

test('a log that itself throws does not take the handler down', () => {
  const proc = new EventEmitter()
  installMainErrorHandlers(proc as never, () => {
    throw new Error('disk full')
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(() => proc.emit('uncaughtExceptionMonitor', new Error('x'))).not.toThrow()
})
