import { afterEach, expect, test, vi } from 'vitest'
import { withFault } from '../../src/main/testSeams/ipcFaults'

afterEach(() => {
  delete process.env.QCLOD_FAKE_SLOW
  delete process.env.QCLOD_FAKE_FAIL
  delete process.env.QCLOD_FAKE_FAIL_TIMES
})

test('без шва просто выполняет', async () => expect(await withFault('history:list', () => 1)).toBe(1))

test('QCLOD_FAKE_FAIL бросает с текстом', async () => {
  process.env.QCLOD_FAKE_FAIL = JSON.stringify({ 'history:list': 'нет доступа' })
  await expect(withFault('history:list', () => 1)).rejects.toThrow('нет доступа')
})

test('QCLOD_FAKE_FAIL не трогает другие каналы', async () => {
  process.env.QCLOD_FAKE_FAIL = JSON.stringify({ 'history:list': 'нет доступа' })
  expect(await withFault('settings:get', () => 2)).toBe(2)
})

test('QCLOD_FAKE_SLOW ждёт', async () => {
  process.env.QCLOD_FAKE_SLOW = JSON.stringify({ 'settings:get': 50 })
  const t0 = Date.now()
  await withFault('settings:get', () => 1)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
})

test('QCLOD_FAKE_FAIL_TIMES отказывает первые n раз, потом пропускает', async () => {
  process.env.QCLOD_FAKE_FAIL = JSON.stringify({ 'agent:ribbon': 'сломалось' })
  process.env.QCLOD_FAKE_FAIL_TIMES = JSON.stringify({ 'agent:ribbon': 2 })
  await expect(withFault('agent:ribbon', () => 1)).rejects.toThrow('сломалось')
  await expect(withFault('agent:ribbon', () => 1)).rejects.toThrow('сломалось')
  expect(await withFault('agent:ribbon', () => 3)).toBe(3)
})

test('кривой JSON в шве не роняет вызов, а говорит о себе в консоли', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  process.env.QCLOD_FAKE_FAIL = '{не json'
  expect(await withFault('history:list', () => 4)).toBe(4)
  expect(warn).toHaveBeenCalledWith('[seam] QCLOD_FAKE_FAIL is not valid JSON, ignored')
  warn.mockRestore()
})
