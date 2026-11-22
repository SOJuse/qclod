import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('window.qclod есть, window.require нет', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-e2e-'))
  const app = await electron.launch({ args: ['.'], env: { ...(process.env as Record<string, string>), QCLOD_USER_DATA: profile } })
  const win = await app.firstWindow()
  await win.locator('[data-testid="app-root"]').waitFor()

  const probe = await win.evaluate(() => ({
    hasApi: typeof (window as never as { qclod?: unknown }).qclod === 'object',
    canSend: typeof (window as never as { qclod?: { send?: unknown } }).qclod?.send === 'function',
    hasRequire: typeof (window as never as { require?: unknown }).require !== 'undefined',
    hasProcess: typeof (window as never as { process?: unknown }).process !== 'undefined',
    leaksIpc:
      typeof (window as never as { qclod?: Record<string, unknown> }).qclod?.['ipcRenderer'] !==
      'undefined'
  }))

  expect(probe.hasApi).toBe(true)
  expect(probe.canSend).toBe(true)
  expect(probe.hasRequire).toBe(false)
  expect(probe.hasProcess).toBe(false)
  expect(probe.leaksIpc).toBe(false)

  const version = await win.evaluate(() =>
    (window as never as { qclod: { appVersion(): Promise<string> } }).qclod.appVersion()
  )
  expect(version).toBe(JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).version)

  await app.close()
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
})
