import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let win: Page
let profile: string

test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), 'qclod-settings-'))
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({
        steps: [{ kind: 'text', text: 'готово' }],
        init: { model: 'claude-opus-5' }
      })
    } as Record<string, string>
  })
  win = await app.firstWindow()
  // The model list arrives with the session; the panel shows it once it is there.
  await expect(win.locator('[data-testid="panel-model"]')).toContainText('Opus 5', { timeout: 15000 })
  await win.locator('[data-testid="open-settings"]').click()
  await expect(win.locator('[data-testid="settings"]')).toBeVisible()
})

test.afterEach(async () => {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
})

test('режим по умолчанию — список без «без проверок»', async () => {
  const options = await win.locator('[data-testid="setting-defaultPermissionMode"] option').allTextContents()
  expect(options).not.toContain('без проверок')
  expect(options).toContain('принимать правки')
})

test('модель по умолчанию — список моделей сессии', async () => {
  const options = await win.locator('[data-testid="setting-defaultModel"] option').allTextContents()
  expect(options).toContain('Как у Claude Code')
  expect(options).toContain('Opus 5')
  expect(options).toContain('Sonnet 5')
})

test('усилие по умолчанию — список с подписями', async () => {
  const options = await win.locator('[data-testid="setting-defaultEffort"] option').allTextContents()
  expect(options).toContain('Как у Claude Code')
  expect(options).toContain('высокое')
})

test('изменение видно как «Сохранено» и попадает в файл', async () => {
  await win.locator('[data-testid="setting-defaultModel"]').selectOption('claude-sonnet-5')
  const saved = win.locator('[data-testid="settings-saved"]')
  await expect(saved).toBeVisible()
  await expect(saved).toHaveText('Сохранено')
  await expect(saved).toBeHidden({ timeout: 5000 })
  const file = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
  expect(file.defaults.model).toBe('claude-sonnet-5')
})

test('Esc закрывает настройки и сохраняет поле, которое ещё в фокусе', async () => {
  const input = win.locator('[data-testid="setting-agentPath"]')
  await input.fill('claude-custom')
  await input.press('Escape')
  await expect(win.locator('[data-testid="settings"]')).toHaveCount(0)
  await win.locator('[data-testid="open-settings"]').click()
  await expect(win.locator('[data-testid="setting-agentPath"]')).toHaveValue('claude-custom')
})

test('поля «Размер шрифта терминала» нет', async () => {
  await expect(win.locator('[data-testid="setting-fontSize"]')).toHaveCount(0)
})
