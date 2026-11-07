import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(agentPath: string): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-setup-'))
  // The agent path is a setting, so a profile that names a missing one is how
  // a machine without Claude Code looks.
  require('node:fs').writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ agentPath }),
    'utf8'
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({ steps: [] })
    } as Record<string, string>
  })
  return { app, profile }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

test('без Claude Code встречает экран установки, а не пустое окно', async () => {
  const { app, profile } = await launch('такого-файла-нет-12345')
  try {
    const win = await app.firstWindow()
    const setup = win.locator('[data-testid="setup-screen"]')

    await expect(setup).toBeVisible({ timeout: 20000 })
    await expect(setup).toContainText('Claude Code')
    await expect(win.locator('[data-testid="setup-install"]')).toBeVisible()

    // Nothing to work in until it is there.
    await expect(win.locator('[data-testid="setup-done"]')).toBeDisabled()
    await expect(win.locator('[data-testid="composer-input"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('Node.js на этой машине показан найденным', async () => {
  const { app, profile } = await launch('такого-файла-нет-12345')
  try {
    const win = await app.firstWindow()
    const node = win.locator('[data-testid="setup-Node.js"]')

    await expect(node).toBeVisible({ timeout: 20000 })
    await expect(node).toHaveClass(/is-found/)
    await expect(node).toContainText(/\d+\.\d+\.\d+/)
  } finally {
    await close(app, profile)
  }
})

test('с установленным агентом экран установки не мешает', async () => {
  const { app, profile } = await launch('claude')
  try {
    const win = await app.firstWindow()

    await expect(win.locator('[data-testid="composer-input"]')).toBeVisible({ timeout: 20000 })
    await expect(win.locator('[data-testid="setup-screen"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})
