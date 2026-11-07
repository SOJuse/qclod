import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(
  script: unknown,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-composer-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(script),
      ...extraEnv
    } as Record<string, string>
  })
  return { app, profile }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

test('введённое отправляется и возвращается ответом', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'text', text: 'слушаю' }],
    nextTurn: [{ kind: 'text', text: 'сделал рефактор' }]
  })
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.fill('сделай рефактор auth.ts')
    await input.press('Enter')

    // The user's own words appear at once, not after the answer.
    await expect(win.locator('[data-testid="ribbon-user"]')).toContainText('сделай рефактор auth.ts')
    await expect(input).toHaveValue('')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('сделал рефактор', {
      timeout: 15000
    })
  } finally {
    await close(app, profile)
  }
})

test('Shift+Enter переносит строку, а не отправляет', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.type('первая строка')
    await input.press('Shift+Enter')
    await input.type('вторая строка')

    await expect(input).toHaveValue('первая строка\nвторая строка')
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('скрепка добавляет файл и он виден плашкой в поле', async () => {
  const picked = join(mkdtempSync(join(tmpdir(), 'qclod-pick-')), 'мой файл.ts')
  writeFileSync(picked, 'export const x = 1\n', 'utf8')

  const { app, profile } = await launch({ steps: [] }, { QCLOD_PICK_FILES: picked })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-clip"]').click({ timeout: 15000 })

    const chip = win.locator('[data-testid="composer-chip"]')
    await expect(chip).toHaveCount(1)
    await expect(chip).toContainText('мой файл.ts')
  } finally {
    await close(app, profile)
    rmSync(join(picked, '..'), { recursive: true, force: true })
  }
})

test('плашку можно убрать до отправки', async () => {
  const picked = join(mkdtempSync(join(tmpdir(), 'qclod-pick-')), 'лишний.ts')
  writeFileSync(picked, 'x', 'utf8')

  const { app, profile } = await launch({ steps: [] }, { QCLOD_PICK_FILES: picked })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-clip"]').click({ timeout: 15000 })
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(1)

    await win.locator('[data-testid="composer-chip-remove"]').click()
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
    rmSync(join(picked, '..'), { recursive: true, force: true })
  }
})

test('черновик и вложения переживают переключение вкладок', async () => {
  const other = mkdtempSync(join(tmpdir(), 'qclod-other-'))
  mkdirSync(join(other, 'src'), { recursive: true })
  const picked = join(mkdtempSync(join(tmpdir(), 'qclod-pick-')), 'черновик.ts')
  writeFileSync(picked, 'x', 'utf8')

  const { app, profile } = await launch(
    { steps: [] },
    { QCLOD_PICK_FILES: picked, QCLOD_PICK_FOLDER: other }
  )
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.fill('недописанная мысль')
    await win.locator('[data-testid="composer-clip"]').click()
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(1)

    // Second tab: its own, empty draft.
    await win.locator('[data-testid="tab-new"]').click()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })
    await expect(input).toHaveValue('')
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(0)

    // Back to the first: everything is where it was left.
    await win.locator('[data-testid="tab"]').first().click()
    await expect(input).toHaveValue('недописанная мысль')
    await expect(win.locator('[data-testid="composer-chip"]')).toContainText('черновик.ts')
  } finally {
    await close(app, profile)
    rmSync(other, { recursive: true, force: true })
    rmSync(join(picked, '..'), { recursive: true, force: true })
  }
})

test('Esc прерывает агента, даже когда в поле есть текст', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'text', text: 'работаю' }],
    // Paced, so the agent is still mid-answer when Esc arrives.
    nextTurn: [
      { kind: 'textStream', pieces: ['ещё ', 'работаю', '…'], pauseMs: 1500 }
    ]
  })
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.fill('поехали')
    await input.press('Enter')
    await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 15000 })

    await input.fill('а теперь я передумал')
    await input.press('Escape')

    // The draft stays; it is the agent that stops.
    await expect(input).toHaveValue('а теперь я передумал')
    await expect(win.locator('[data-testid="composer-send"]')).toBeVisible({ timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})
