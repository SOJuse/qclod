import { test, expect, _electron as electron } from '@playwright/test'

test('окно открывается и показывает название', async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await expect(win.locator('[data-testid="app-root"]')).toContainText('Qclod')
  await app.close()
})
