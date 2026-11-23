// 1.0.1: vpn — the row at the foot of the sidebar and the «VPN» section, with the fake client (QCLOD_FAKE_VPN).
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Made up: no real server, no real secret.
const LINK = 'hysteria2://fake-auth@vpn.example.org:8444/?sni=vpn.example.org&obfs=salamander&obfs-password=fake-obfs&mport=20000-40000#Тест'

let profile: string
const apps: ElectronApplication[] = []

function launch(): Promise<ElectronApplication> {
  return electron
    .launch({
      args: ['.'],
      env: { ...process.env, QCLOD_USER_DATA: profile, QCLOD_FAKE_VPN: '1' } as Record<string, string>
    })
    .then((a) => {
      apps.push(a)
      return a
    })
}

test.beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'qclod-vpn-'))
})

test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
})

test('VPN: ссылка в настройках, подключение, значок; при следующем запуске Claude стартует через прокси', async () => {
  let app = await launch()
  let win = await app.firstWindow()
  const button = win.locator('[data-testid="vpn-button"]')
  await expect(button).toBeVisible({ timeout: 15000 })
  await expect(button).toHaveAttribute('data-status', 'off')

  await button.click()
  await expect(win.locator('[data-testid="vpn-server"]')).toHaveText('Ссылка не задана')
  await win.locator('[data-testid="vpn-settings"]').click()
  await expect(win.locator('[data-testid="settings"]')).toBeVisible()

  await win.locator('[data-testid="vpn-link"]').fill('vless://nope')
  await win.locator('[data-testid="vpn-link-save"]').click()
  await expect(win.locator('[data-testid="vpn-link-error"]')).toContainText('hysteria2://')

  await win.locator('[data-testid="vpn-link"]').fill(LINK)
  await win.locator('[data-testid="vpn-link-save"]').click()
  await expect(win.locator('[data-testid="vpn-link"]')).toHaveAttribute('placeholder', /vpn\.example\.org \(Тест\)/)
  await expect(win.locator('[data-testid="vpn-sites"]')).toHaveValue(/^anthropic\.com\nclaude\.ai/)
  await expect(win.locator('[data-testid="setting-vpnAutoConnect"]')).toBeChecked()

  await win.locator('[data-testid="vpn-section-toggle"]').click()
  await expect(win.locator('[data-testid="vpn-state"]')).toHaveText('Подключён · 42 мс')
  await expect(button).toHaveAttribute('data-status', 'connected')
  await expect(win.locator('[data-testid="vpn-latency"]')).toHaveText('42 мс')

  // The secret stays in main: not in the page, not in the clear on disk.
  expect(await win.content()).not.toContain('fake-obfs')
  expect(readFileSync(join(profile, 'vpn.json'), 'utf8')).not.toContain('fake-auth')

  await app.close()
  apps.splice(0)

  // Auto-connect at start; the first chat's agent is given the local proxy.
  app = await launch()
  win = await app.firstWindow()
  await expect(win.locator('[data-testid="vpn-button"]')).toHaveAttribute('data-status', 'connected', { timeout: 15000 })
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __qclodAgentProxy?: string | null }).__qclodAgentProxy ?? 'none'), {
      timeout: 15000
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

  // Off: the menu says so.
  await win.locator('[data-testid="vpn-button"]').click()
  await win.locator('[data-testid="vpn-toggle"]').click()
  await expect(win.locator('[data-testid="vpn-button"]')).toHaveAttribute('data-status', 'off')
})
