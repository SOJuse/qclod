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
let projectB: string

async function launch(pickFolder?: string): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      ...(pickFolder ? { QCLOD_PICK_FOLDER: pickFolder } : {})
    } as Record<string, string>
  })
  win = await app.firstWindow()
  await expect(win.locator('[data-testid="tab-strip"]')).toBeVisible()
}

test.beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'qclod-prof-'))
  projectB = mkdtempSync(join(tmpdir(), 'qclod-projB-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  for (const dir of [profile, projectB]) rmSync(dir, { recursive: true, force: true })
})

test('Ctrl+T создаёт вкладку с выбранной папкой', async () => {
  await launch(projectB)
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(1)

  await win.keyboard.press('Control+t')
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(2)
  await expect(win.locator('[data-testid="tab"]').nth(1)).toContainText(
    projectB.split(/[\\/]/).pop() as string
  )
})

test('Ctrl+W закрывает вкладку', async () => {
  await launch(projectB)
  await win.keyboard.press('Control+t')
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(2)

  await win.keyboard.press('Control+w')
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(1)
})

test('закрытие последней вкладки оставляет окно с новой вкладкой', async () => {
  await launch()
  await win.keyboard.press('Control+w')
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(1)
})

test('Ctrl+2 переключает на вторую вкладку', async () => {
  await launch(projectB)
  await win.keyboard.press('Control+t')
  await expect(win.locator('[data-testid="tab"]').nth(1)).toHaveClass(/is-active/)

  await win.keyboard.press('Control+1')
  await expect(win.locator('[data-testid="tab"]').nth(0)).toHaveClass(/is-active/)

  await win.keyboard.press('Control+2')
  await expect(win.locator('[data-testid="tab"]').nth(1)).toHaveClass(/is-active/)
})

test('Ctrl+Tab идёт по кругу', async () => {
  await launch(projectB)
  await win.keyboard.press('Control+t')
  await win.keyboard.press('Control+Tab')
  await expect(win.locator('[data-testid="tab"]').nth(0)).toHaveClass(/is-active/)
  await win.keyboard.press('Control+Tab')
  await expect(win.locator('[data-testid="tab"]').nth(1)).toHaveClass(/is-active/)
})

test('недоотправленный черновик не теряется при переключении вкладок', async () => {
  await launch(projectB)
  await win.locator('[data-testid="composer-input"]').click()
  await win.keyboard.type('черновик первой вкладки')

  await win.keyboard.press('Control+t')
  await expect(win.locator('[data-testid="composer-input"]')).toHaveValue('')

  await win.keyboard.press('Control+1')
  await expect(win.locator('[data-testid="composer-input"]')).toHaveValue(
    'черновик первой вкладки'
  )
})

test('вкладки восстанавливаются после перезапуска с теми же папками', async () => {
  await launch(projectB)
  await win.keyboard.press('Control+t')
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(2)
  const titles = await win.locator('[data-testid="tab"]').allInnerTexts()
  await app.close()

  await launch()
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(2)
  const restored = await win.locator('[data-testid="tab"]').allInnerTexts()
  expect(restored).toEqual(titles)
})

test('кнопки окна сворачивают и разворачивают', async () => {
  await launch()

  await win.locator('[data-testid="window-minimize"]').click()
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())
  ).toBe(true)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
  await win.locator('[data-testid="window-maximize"]').click()
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())
  ).toBe(true)
})
