import { test, expect, _electron as electron } from '@playwright/test'

test('окно открывается, представляется и показывает вкладку', async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()

  await expect(win.locator('[data-testid="title-bar"]')).toBeVisible()
  await expect(win).toHaveTitle(/Qclod/)
  // A window with no tab has nothing to do; there is always one.
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(1)

  await app.close()
})
