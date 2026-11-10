import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ShellEntry = { action: string; path: string }

async function launch(script: unknown): Promise<{ app: ElectronApplication; profile: string; win: Page }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-input-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(script),
      QCLOD_FAKE_SHELL: '1'
    } as Record<string, string>
  })
  const win = await app.firstWindow()
  await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
  return { app, profile, win }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

/** A screenshot in the system clipboard, as a screenshot tool leaves it. */
async function copyScreenshot(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ clipboard, nativeImage }, size) =>
      clipboard.writeImage(
        nativeImage.createFromBitmap(Buffer.alloc(size.width * size.height * 4, 200), size)
      ),
    { width, height }
  )
}

async function paste(win: Page): Promise<void> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.click()
  await input.press('Control+V')
}

test('Ctrl+V скриншота — миниатюра в поле, крестик убирает', async () => {
  const { app, profile, win } = await launch({ steps: [] })
  try {
    await copyScreenshot(app, 64, 48)
    await paste(win)

    await expect(win.locator('[data-testid="composer-chip-thumb"]')).toBeVisible({ timeout: 10000 })
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveAttribute('title', 'Снимок 64×48')
    // The picture is not pasted as text as well.
    await expect(win.locator('[data-testid="composer-input"]')).toHaveValue('')
    // main kept a copy in the app's own folder.
    expect(readdirSync(join(profile, 'pastes'))).toHaveLength(1)

    await win.locator('[data-testid="composer-chip-remove"]').click()
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('картинка уходит агенту настоящим вложением и видна в пузыре', async () => {
  const { app, profile, win } = await launch({ steps: [], nextTurn: [{ kind: 'reportInput' }] })
  try {
    await copyScreenshot(app, 64, 48)
    await paste(win)
    await expect(win.locator('[data-testid="composer-chip-thumb"]')).toBeVisible({ timeout: 10000 })
    await win.locator('[data-testid="composer-input"]').fill('что на снимке?')
    await win.locator('[data-testid="composer-input"]').press('Enter')

    const ribbon = win.locator('[data-testid="ribbon"]')
    await expect(ribbon).toContainText('картинок: 1; типы: image/png; байт: ', { timeout: 15000 })
    // Real bytes, not an empty block.
    await expect(ribbon).not.toContainText('байт: 0')
    const thumb = win.locator('[data-testid="row-user-image"]')
    await expect(thumb).toBeVisible()
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(0)

    // The thumbnail opens the saved copy, through the pastes exception.
    await thumb.click()
    const saved = join(profile, 'pastes', readdirSync(join(profile, 'pastes'))[0] as string)
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __qclodShellLog?: ShellEntry[] }).__qclodShellLog ?? []))
      .toEqual([{ action: 'open', path: saved }])
  } finally {
    await close(app, profile)
  }
})

test('Enter сразу после вставки ждёт снимок и отправляет его', async () => {
  const { app, profile, win } = await launch({ steps: [], nextTurn: [{ kind: 'reportInput' }] })
  try {
    await copyScreenshot(app, 1200, 900)
    await paste(win)
    await win.locator('[data-testid="composer-input"]').press('Enter')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('картинок: 1', { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('большой снимок уменьшается до 2000 по большей стороне', async () => {
  const { app, profile, win } = await launch({ steps: [] })
  try {
    await copyScreenshot(app, 3000, 2000)
    await paste(win)
    await expect(win.locator('[data-testid="composer-chip-thumb"]')).toBeVisible({ timeout: 15000 })
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveAttribute('title', /2000×1333/)
  } finally {
    await close(app, profile)
  }
})

test('черновик со снимком переживает перезагрузку окна и уходит с байтами', async () => {
  const { app, profile, win } = await launch({ steps: [], nextTurn: [{ kind: 'reportInput' }] })
  try {
    await copyScreenshot(app, 64, 48)
    await paste(win)
    await expect(win.locator('[data-testid="composer-chip-thumb"]')).toBeVisible({ timeout: 10000 })

    await win.reload()
    await expect(win.locator('[data-testid="composer-chip-thumb"]')).toBeVisible({ timeout: 15000 })
    await win.locator('[data-testid="composer-input"]').press('Enter')
    const ribbon = win.locator('[data-testid="ribbon"]')
    await expect(ribbon).toContainText('картинок: 1; типы: image/png', { timeout: 15000 })
    await expect(ribbon).not.toContainText('байт: 0')
  } finally {
    await close(app, profile)
  }
})
