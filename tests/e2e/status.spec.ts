import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let win: Page
let profile: string

test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), 'qclod-prof-'))
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, QCLOD_USER_DATA: profile } as Record<string, string>
  })
  win = await app.firstWindow()
  await expect(win.locator('[data-testid="terminal"]').first()).toContainText('fake-agent ready', {
    timeout: 20000
  })
  await win.locator('[data-testid="composer-input"]').click()
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
})

test('отправка переводит вкладку в работу, хук Stop — в простой', async () => {
  const dot = win.locator('[data-testid="tab"] .tab-status').first()

  await win.keyboard.type('привет')
  await win.keyboard.press('Enter')
  await expect(dot).toHaveClass(/is-busy/)

  // The fake agent fires the real Stop hook through bin/qclod-hook.js.
  await expect(dot).toHaveClass(/is-idle/, { timeout: 15000 })
  await expect(dot).not.toHaveClass(/is-degraded/)
})

test('запрос разрешения переводит вкладку в ожидание', async () => {
  const dot = win.locator('[data-testid="tab"] .tab-status').first()

  await win.keyboard.type('/ask')
  await win.keyboard.press('Enter')

  await expect(dot).toHaveClass(/is-waiting/, { timeout: 15000 })
})
