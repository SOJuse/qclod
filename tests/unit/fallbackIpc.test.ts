import { expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { registerFallbackIpc } from '../../src/main/fallbackIpc'
import { CHANNELS } from '../../src/shared/channels'

function setup(openResult = '') {
  const handlers = new Map<string, () => unknown>()
  const deps = {
    ipcMain: { handle: (ch: string, fn: () => unknown) => void handlers.set(ch, fn) },
    openPath: vi.fn(async () => openResult),
    userData: 'C:\data',
    resetWatch: vi.fn(),
    reload: vi.fn()
  }
  registerFallbackIpc(deps as never)
  return { handlers, deps }
}

test('the retry clears the watchdog count, then loads the window', async () => {
  const { handlers, deps } = setup()
  const order: string[] = []
  deps.resetWatch.mockImplementation(() => order.push('reset'))
  deps.reload.mockImplementation(() => order.push('reload'))
  await handlers.get(CHANNELS.rendererRetry)!()
  expect(order).toEqual(['reset', 'reload'])
})

test('the log button opens userData/logs', async () => {
  const { handlers, deps } = setup()
  await handlers.get(CHANNELS.logsOpen)!()
  expect(deps.openPath).toHaveBeenCalledWith(join('C:\data', 'logs'))
})

test('a folder that cannot be opened is an error for the page, not silence', async () => {
  const { handlers } = setup('нет такой папки')
  await expect(handlers.get(CHANNELS.logsOpen)!()).rejects.toThrow('нет такой папки')
})
