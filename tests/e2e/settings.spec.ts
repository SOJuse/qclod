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
let project: string

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_PICK_FOLDER: project
    } as Record<string, string>
  })
  win = await app.firstWindow()
  await expect(win.locator('[data-testid="tab-strip"]')).toBeVisible()
}

test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), 'qclod-prof-'))
  project = mkdtempSync(join(tmpdir(), 'qclod-proj-'))
  await launch()
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  for (const dir of [profile, project]) rmSync(dir, { recursive: true, force: true })
})

test('смена размера шрифта сразу видна в терминале', async () => {
  const terminal = win.locator('[data-testid="terminal"]').first()
  const before = await terminal.locator('.xterm-rows').evaluate((el) => getComputedStyle(el).fontSize)

  await win.locator('[data-testid="open-settings"]').click()
  await win.locator('[data-testid="setting-fontSize"]').fill('20')
  await win.locator('[data-testid="setting-fontSize"]').blur()

  await expect
    .poll(async () =>
      terminal.locator('.xterm-rows').evaluate((el) => getComputedStyle(el).fontSize)
    )
    .not.toBe(before)
})

test('выключение автофокуса переживает перезапуск', async () => {
  await win.locator('[data-testid="open-settings"]').click()
  await win.locator('[data-testid="setting-autoFocusOnMenu"]').uncheck()
  await expect(win.locator('[data-testid="setting-autoFocusOnMenu"]')).not.toBeChecked()

  await app.close()
  await launch()

  await win.locator('[data-testid="open-settings"]').click()
  await expect(win.locator('[data-testid="setting-autoFocusOnMenu"]')).not.toBeChecked()
})

test('переопределение модели на вкладке не меняет глобальную настройку', async () => {
  await win.locator('[data-testid="open-settings"]').click()
  await win.locator('[data-testid="setting-defaultModel"]').fill('opus')
  await win.locator('[data-testid="setting-defaultModel"]').blur()
  await win.locator('[data-testid="close-settings"]').click()

  await win.locator('[data-testid="tab"]').first().click({ button: 'right' })
  await win.locator('[data-testid="tab-setting-model"]').fill('haiku')
  await win.locator('[data-testid="tab-settings-save"]').click()

  await win.locator('[data-testid="open-settings"]').click()
  await expect(win.locator('[data-testid="setting-defaultModel"]')).toHaveValue('opus')
})

test('переопределения вкладки переживают перезапуск', async () => {
  await win.locator('[data-testid="tab"]').first().click({ button: 'right' })
  await win.locator('[data-testid="tab-setting-model"]').fill('haiku')
  await win.locator('[data-testid="tab-settings-save"]').click()

  await app.close()
  await launch()

  await win.locator('[data-testid="tab"]').first().click({ button: 'right' })
  await expect(win.locator('[data-testid="tab-setting-model"]')).toHaveValue('haiku')
})

test('экран настроек показывает текущую комбинацию вызова', async () => {
  await win.locator('[data-testid="open-settings"]').click()
  await expect(win.locator('[data-testid="setting-globalHotkey"]')).toHaveValue(
    'Control+Shift+Space'
  )
})
