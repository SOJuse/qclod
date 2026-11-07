import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let win: Page
let profile: string

async function launch(env: Record<string, string> = {}): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, QCLOD_USER_DATA: profile, ...env } as Record<string, string>
  })
  win = await app.firstWindow()
  await expect(win.locator('[data-testid="tab-strip"]')).toBeVisible()
}

test.beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'qclod-prof-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
})

test('агент не найден — объяснение и кнопка открыть настройки', async () => {
  await launch({
    QCLOD_AGENT_PATH: 'definitely-not-installed-agent',
    QCLOD_AGENT_PREFIX_ARGS: '[]'
  })

  const panel = win.locator('[data-testid="tab-error"]')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('definitely-not-installed-agent')

  await panel.locator('[data-testid="error-open-settings"]').click()
  await expect(win.locator('[data-testid="settings"]')).toBeVisible()
})

test('агент вышел с кодом 3 — показан код и кнопка перезапустить', async () => {
  await launch()
  await expect(win.locator('[data-testid="terminal"]').first()).toContainText('fake-agent ready', {
    timeout: 20000
  })

  await win.locator('[data-testid="composer-input"]').click()
  await win.keyboard.type('/exit 3')
  await win.keyboard.press('Enter')

  const panel = win.locator('[data-testid="tab-error"]')
  await expect(panel).toBeVisible({ timeout: 15000 })
  await expect(panel).toContainText('3')
  await expect(panel.locator('[data-testid="error-restart"]')).toBeVisible()
})

test('прочитанный вывод остаётся виден после выхода процесса', async () => {
  await launch()
  const terminal = win.locator('[data-testid="terminal"]').first()
  await expect(terminal).toContainText('fake-agent ready', { timeout: 20000 })

  await win.locator('[data-testid="composer-input"]').click()
  await win.keyboard.type('запомни это')
  await win.keyboard.press('Enter')
  await expect(terminal).toContainText('[submit 1]', { timeout: 15000 })

  await win.keyboard.type('/exit 1')
  await win.keyboard.press('Enter')
  await expect(win.locator('[data-testid="tab-error"]')).toBeVisible({ timeout: 15000 })

  await expect(terminal).toContainText('запомни это')
})

test('перезапуск поднимает сессию в той же вкладке', async () => {
  await launch()
  const terminal = win.locator('[data-testid="terminal"]').first()
  await expect(terminal).toContainText('fake-agent ready', { timeout: 20000 })

  const tabTitle = await win.locator('[data-testid="tab"]').first().innerText()

  await win.locator('[data-testid="composer-input"]').click()
  await win.keyboard.type('/exit 2')
  await win.keyboard.press('Enter')
  await expect(win.locator('[data-testid="tab-error"]')).toBeVisible({ timeout: 15000 })

  await win.locator('[data-testid="error-restart"]').click()

  await expect(win.locator('[data-testid="tab-error"]')).toBeHidden({ timeout: 15000 })
  await expect(win.locator('[data-testid="composer-input"]')).toBeVisible()
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(1)
  expect(await win.locator('[data-testid="tab"]').first().innerText()).toBe(tabTitle)
})

test('путь к агенту можно починить из настроек без перезапуска приложения', async () => {
  // The full recovery loop spec 6.10 promises: error panel → settings → fix
  // the path → restart → working session.
  const { QCLOD_AGENT_PATH: _dropped, ...withoutAgentOverride } = process.env
  const fakeAgent = join(process.cwd(), 'tests', 'fixtures', 'fake-agent', 'index.js')

  // Seed a broken agent path in the profile. The env override is dropped so
  // the setting is what decides — and the path is one that cannot exist, so
  // this can never reach the real CLI.
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ agentPath: 'qclod-no-such-agent-xyz' }),
    'utf8'
  )

  app = await electron.launch({
    args: ['.'],
    env: {
      ...withoutAgentOverride,
      QCLOD_USER_DATA: profile,
      QCLOD_AGENT_PREFIX_ARGS: JSON.stringify([fakeAgent])
    } as Record<string, string>
  })
  win = await app.firstWindow()

  await expect(win.locator('[data-testid="tab-error"]')).toBeVisible({ timeout: 20000 })

  await win.locator('[data-testid="error-open-settings"]').click()
  await win.locator('[data-testid="setting-agentPath"]').fill(process.execPath)
  await win.locator('[data-testid="setting-agentPath"]').blur()
  await win.locator('[data-testid="close-settings"]').click()

  await win.locator('[data-testid="error-restart"]').click()

  await expect(win.locator('[data-testid="tab-error"]')).toBeHidden({ timeout: 20000 })
  await expect(win.locator('[data-testid="terminal"]').first()).toContainText('fake-agent ready', {
    timeout: 20000
  })
})
