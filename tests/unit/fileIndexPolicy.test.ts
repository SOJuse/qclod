import { describe, expect, test } from 'vitest'
import { fileIndexAsk, fileIndexKept } from '../../src/renderer/app/fileIndexPolicy'

describe('индекс файлов серверной вкладки (Minor)', () => {
  test('локальная вкладка — один раз, пустой тоже хранится', () => {
    expect(fileIndexAsk({ cached: false, serverState: null, cameOnline: false })).toBe(true)
    expect(fileIndexAsk({ cached: true, serverState: null, cameOnline: false })).toBe(false)
    expect(fileIndexKept(null, [])).toBe(true)
  })

  test('сервер не на связи — не спрашиваем; вернулся — спрашиваем снова, даже если был список', () => {
    expect(fileIndexAsk({ cached: false, serverState: 'offline', cameOnline: false })).toBe(false)
    expect(fileIndexAsk({ cached: false, serverState: 'online', cameOnline: false })).toBe(true)
    expect(fileIndexAsk({ cached: true, serverState: 'online', cameOnline: false })).toBe(false)
    expect(fileIndexAsk({ cached: true, serverState: 'online', cameOnline: true })).toBe(true)
  })

  test('пустой ответ сервера не кэшируется', () => {
    expect(fileIndexKept('online', [])).toBe(false)
    expect(fileIndexKept('online', ['a.ts'])).toBe(true)
  })
})
