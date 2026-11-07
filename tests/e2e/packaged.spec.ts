import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.env['QCLOD_PACKAGED_EXE']

/**
 * Runs the real packaged build rather than `electron .`, which is the only way
 * to catch problems that exist only after packaging: files missing from the
 * asar, and the SDK's own files being unreachable inside it.
 *
 * Enable with: QCLOD_PACKAGED_EXE=dist/win-unpacked/Qclod.exe
 *
 * Task 16 extends this to a full round trip (send a message, read the ribbon)
 * once packaging is settled for the SDK.
 */
test.skip(!exe, 'задать QCLOD_PACKAGED_EXE, чтобы проверить собранное приложение')

test('собранное приложение запускается и поднимает мост', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-packaged-'))
  const app = await electron.launch({
    executablePath: exe,
    args: [],
    env: { ...process.env, QCLOD_USER_DATA: profile, QCLOD_HEADLESS: '1' } as Record<string, string>
  })

  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="app-ready"]').waitFor({ timeout: 30000 })

    const version = await win.evaluate(() =>
      (window as never as { qclod: { appVersion(): Promise<string> } }).qclod.appVersion()
    )
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  } finally {
    await app.close().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
})
