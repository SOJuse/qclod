import { test, _electron as electron } from '@playwright/test'

/**
 * Not an assertion — a way to look at the app. Run with
 * `npx playwright test screenshot` and open tests/.artifacts/qclod.png.
 */
test.skip(process.env['QCLOD_SHOT'] !== '1', 'снимок делается только по QCLOD_SHOT=1')

test('снимок окна', async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.locator('[data-testid="terminal"]').waitFor()
  await win.waitForTimeout(1500)

  await win.locator('[data-testid="composer-input"]').click()
  await win.keyboard.type('сделай рефактор auth.ts')
  await win.waitForTimeout(400)

  await win.screenshot({ path: 'tests/.artifacts/qclod.png' })
  await app.close()
})
