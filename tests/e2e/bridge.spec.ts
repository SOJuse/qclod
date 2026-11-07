import { test, expect, _electron as electron } from '@playwright/test'

test('window.qclod есть, window.require нет', async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.locator('[data-testid="app-root"]').waitFor()

  const probe = await win.evaluate(() => ({
    hasApi: typeof (window as never as { qclod?: unknown }).qclod === 'object',
    canWrite: typeof (window as never as { qclod?: { write?: unknown } }).qclod?.write === 'function',
    hasRequire: typeof (window as never as { require?: unknown }).require !== 'undefined',
    hasProcess: typeof (window as never as { process?: unknown }).process !== 'undefined',
    leaksIpc:
      typeof (window as never as { qclod?: Record<string, unknown> }).qclod?.['ipcRenderer'] !==
      'undefined'
  }))

  expect(probe.hasApi).toBe(true)
  expect(probe.canWrite).toBe(true)
  expect(probe.hasRequire).toBe(false)
  expect(probe.hasProcess).toBe(false)
  expect(probe.leaksIpc).toBe(false)

  const version = await win.evaluate(() =>
    (window as never as { qclod: { appVersion(): Promise<string> } }).qclod.appVersion()
  )
  expect(version).toBe('0.1.0')

  await app.close()
})
