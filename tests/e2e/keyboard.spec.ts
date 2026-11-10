import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(
  script: unknown,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; profile: string; folder: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-keyboard-'))
  const folder = mkdtempSync(join(tmpdir(), 'qclod-keyboard-cwd-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_PICK_FOLDER: folder,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(script),
      ...extraEnv
    } as Record<string, string>
  })
  return { app, profile, folder }
}

async function close(app: ElectronApplication, ...dirs: string[]): Promise<void> {
  await app.close().catch(() => undefined)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

async function ready(win: Page): Promise<void> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.waitFor({ timeout: 15000 })
  await input.click()
}

const tabs = (win: Page) => win.locator('[data-testid="tab"]')
const active = (win: Page) => win.locator('[data-testid="tab"].is-active')

test('Ctrl+T открывает вкладку, Ctrl+1/Ctrl+2 переключают, Ctrl+Tab по кругу', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await expect(tabs(win)).toHaveCount(1)

    await win.keyboard.press('Control+t')
    await expect(tabs(win)).toHaveCount(2)
    await expect(active(win)).toHaveCount(1)
    await expect(tabs(win).nth(1)).toHaveClass(/is-active/)

    await win.keyboard.press('Control+1')
    await expect(tabs(win).nth(0)).toHaveClass(/is-active/)
    await win.keyboard.press('Control+2')
    await expect(tabs(win).nth(1)).toHaveClass(/is-active/)

    // Round the ring: forward from the last wraps to the first, back goes the other way.
    await win.keyboard.press('Control+Tab')
    await expect(tabs(win).nth(0)).toHaveClass(/is-active/)
    await win.keyboard.press('Control+Shift+Tab')
    await expect(tabs(win).nth(1)).toHaveClass(/is-active/)

    // Ctrl+9 is the last tab; Ctrl+5 with only two tabs does nothing.
    await win.keyboard.press('Control+1')
    await win.keyboard.press('Control+9')
    await expect(tabs(win).nth(1)).toHaveClass(/is-active/)
    await win.keyboard.press('Control+5')
    await expect(tabs(win).nth(1)).toHaveClass(/is-active/)
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+W закрывает свободную вкладку сразу', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await win.keyboard.press('Control+t')
    await expect(tabs(win)).toHaveCount(2)

    await win.keyboard.press('Control+w')
    await expect(tabs(win)).toHaveCount(1)
    await expect(win.locator('[data-testid="close-guard"]')).toHaveCount(0)
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+W на работающей вкладке закрывает только со второго раза', async () => {
  const { app, profile, folder } = await launch({
    steps: [{ kind: 'text', text: 'готов' }],
    nextTurn: [{ kind: 'textStream', pieces: ['думаю', ' дальше', ' ещё'], pauseMs: 400 }]
  })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await win.keyboard.press('Control+t')
    await expect(tabs(win)).toHaveCount(2)

    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await input.fill('поехали')
    await input.press('Enter')
    await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 15000 })

    await win.keyboard.press('Control+w')
    const guard = win.locator('[data-testid="close-guard"]')
    await expect(guard).toContainText('Ctrl+W ещё раз закроет вкладку')
    await expect(tabs(win)).toHaveCount(2)

    await win.keyboard.press('Control+w')
    await expect(tabs(win)).toHaveCount(1)
    await expect(guard).toHaveCount(0)
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+K открывает палитру действий; «настр» + Enter открывает настройки', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)

    await win.keyboard.press('Control+k')
    const palette = win.locator('[data-testid="action-palette"]')
    await expect(palette).toBeVisible()
    await expect(win.locator('[data-testid="action-query"]')).toBeFocused()
    await expect(win.locator('[data-testid="action-item"]')).toHaveCount(12)

    // Esc closes it and the cursor goes back to the input.
    await win.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
    await expect(win.locator('[data-testid="composer-input"]')).toBeFocused()

    await win.keyboard.press('Control+k')
    await win.locator('[data-testid="action-query"]').pressSequentially('настр')
    await expect(win.locator('[data-testid="action-item"]').first()).toContainText('Настройки')
    await win.keyboard.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect(win.locator('[data-testid="settings"]')).toBeVisible()
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+K на русской раскладке (код клавиши, не буква) тоже открывает палитру', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await win.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'л', code: 'KeyK', ctrlKey: true, cancelable: true })
      )
    )
    await expect(win.locator('[data-testid="action-palette"]')).toBeVisible()
  } finally {
    await close(app, profile, folder)
  }
})
