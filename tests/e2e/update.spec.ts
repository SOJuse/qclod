import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The update strip against the fake source (QCLOD_FAKE_UPDATE): GitHub is
 * never asked. `fakeUpdate` null runs without the variable at all.
 */
async function launch(
  fakeUpdate: string | null
): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-update-'))
  const env = { ...process.env, QCLOD_USER_DATA: profile } as Record<string, string>
  delete env['QCLOD_FAKE_UPDATE']
  if (fakeUpdate !== null) env['QCLOD_FAKE_UPDATE'] = fakeUpdate
  const app = await electron.launch({ args: ['.'], env })
  return { app, profile }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

const restarts = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => (globalThis as { __qclodUpdateRestarts?: number }).__qclodUpdateRestarts ?? 0)

test('скачанная версия: полоса, «Перезапустить» ставит её, «Позже» прячет', async () => {
  const { app, profile } = await launch('{"version":"9.9.9"}')
  try {
    const win = await app.firstWindow()
    const banner = win.getByTestId('update-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Скачана новая версия 9.9.9.')
    await expect(banner).toHaveAttribute('role', 'status')

    await win.getByTestId('update-restart').click()
    await expect.poll(() => restarts(app)).toBe(1)

    await win.getByTestId('update-later').click()
    await expect(banner).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('нет сети: полосы нет, окно работает', async () => {
  const { app, profile } = await launch('{"error":"net::ERR_INTERNET_DISCONNECTED"}')
  try {
    const win = await app.firstWindow()
    const input = win.getByTestId('composer-input')
    await expect(input).toBeVisible()
    await win.waitForTimeout(3000)
    await expect(win.getByTestId('update-banner')).toHaveCount(0)
    await input.fill('привет')
    await expect(input).toHaveValue('привет')
    expect(await restarts(app)).toBe(0)
  } finally {
    await close(app, profile)
  }
})

test('без лазейки: полосы нет', async () => {
  const { app, profile } = await launch(null)
  try {
    const win = await app.firstWindow()
    await expect(win.getByTestId('title-bar')).toBeVisible()
    await win.waitForTimeout(3000)
    await expect(win.getByTestId('update-banner')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})
