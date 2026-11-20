import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('окно открывается, представляется и показывает вкладку', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-e2e-'))
  const app = await electron.launch({ args: ['.'], env: { ...(process.env as Record<string, string>), QCLOD_USER_DATA: profile } })
  const win = await app.firstWindow()

  // React's first render replaces the loading screen.
  await expect(win.locator('[data-testid="app-root"]')).toBeVisible()
  await expect(win.locator('[data-testid="boot"]')).toHaveCount(0)
  await expect(win.locator('[data-testid="title-bar"]')).toBeVisible()
  await expect(win).toHaveTitle(/Qclod/)
  // A window with no tab has nothing to do; there is always one.
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(1)

  await app.close()
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
})
