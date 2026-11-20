import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pasteImage, screenshotPng } from './helpers/clipboard'

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

/**
 * The screenshot the next paste carries. Kept here rather than in the system
 * clipboard, which belongs to whoever is using the machine (helpers/clipboard.ts).
 */
let copied = ''

/** A screenshot "in the clipboard", as a screenshot tool leaves it. */
async function copyScreenshot(app: ElectronApplication, width: number, height: number): Promise<void> {
  copied = await screenshotPng(app, width, height)
}

/** Ctrl+V of that screenshot into the input line. */
async function paste(win: Page): Promise<void> {
  await pasteImage(win, copied)
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

/**
 * The launch environment, never carrying QCLOD_ALLOW_REAL: a test that runs
 * without the fixture may then only fail, never start the real agent.
 */
function withoutRealAgent(env: Record<string, string | undefined>): Record<string, string> {
  const out = { ...env }
  delete out['QCLOD_ALLOW_REAL']
  return out as Record<string, string>
}

/** Same as launch, with main's image preparation slowed or failed (e2e seams). */
async function launchWith(
  script: unknown,
  env: Record<string, string>
): Promise<{ app: ElectronApplication; profile: string; win: Page }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-input-'))
  const app = await electron.launch({
    args: ['.'],
    env: withoutRealAgent({
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(script),
      QCLOD_FAKE_SHELL: '1',
      ...env
    })
  })
  const win = await app.firstWindow()
  await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
  return { app, profile, win }
}

test('крестик, пока снимок готовится и отправка ждёт, отменяет её: набранное потом не уходит', async () => {
  const { app, profile, win } = await launchWith(
    { steps: [], nextTurn: [{ kind: 'reportInput' }] },
    { QCLOD_PREPARE_DELAY_MS: '1500' }
  )
  try {
    await copyScreenshot(app, 64, 48)
    await paste(win)
    const input = win.locator('[data-testid="composer-input"]')
    await input.press('Enter')
    await win.locator('[data-testid="composer-chip-remove"]').click()
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(0)
    await input.type('п')
    await win.waitForTimeout(2500)
    await expect(input).toHaveValue('п')
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('снимок не удался, пока отправка ждала: текст и плашка с ошибкой остаются, второй Enter шлёт без него', async () => {
  const { app, profile, win } = await launchWith(
    { steps: [], nextTurn: [{ kind: 'reportInput' }] },
    { QCLOD_PREPARE_DELAY_MS: '800', QCLOD_PREPARE_FAIL: '1' }
  )
  try {
    await copyScreenshot(app, 64, 48)
    await paste(win)
    const input = win.locator('[data-testid="composer-input"]')
    await input.fill('посмотри')
    await input.press('Enter')
    const chip = win.locator('[data-testid="composer-chip"]')
    await expect(chip).toHaveClass(/is-error/, { timeout: 10000 })
    await win.waitForTimeout(500)
    await expect(input).toHaveValue('посмотри')
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)

    await input.press('Enter')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('картинок: 0', { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('клик по миниатюре удалённой копии говорит «Файл уже удалён»', async () => {
  const { app, profile, win } = await launch({ steps: [], nextTurn: [{ kind: 'reportInput' }] })
  try {
    await copyScreenshot(app, 64, 48)
    await paste(win)
    await expect(win.locator('[data-testid="composer-chip-thumb"]')).toBeVisible({ timeout: 10000 })
    await win.locator('[data-testid="composer-input"]').press('Enter')
    const thumb = win.locator('[data-testid="row-user-image"]')
    await expect(thumb).toBeVisible({ timeout: 15000 })

    rmSync(join(profile, 'pastes'), { recursive: true, force: true })
    await thumb.click()
    await expect(win.locator('[data-testid="row-user-image-gone"]')).toHaveText('Файл уже удалён')
  } finally {
    await close(app, profile)
  }
})

test('тестовая сборка без QCLOD_FAKE_SDK не запускает настоящего агента и объясняет почему', async () => {
  const { app, profile, win } = await launchWith({ steps: [] }, { QCLOD_FAKE_SDK: '' })
  try {
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('QCLOD_FAKE_SDK', { timeout: 15000 })
    // No agent process was ever made: main says so itself.
    expect(await app.evaluate(() => (globalThis as { __qclodRealAgentStarts?: number }).__qclodRealAgentStarts ?? 0)).toBe(0)
  } finally {
    await close(app, profile)
  }
})

test('↑ приносит прошлое сообщение, ↓ возвращает черновик', async () => {
  const { app, profile, win } = await launch({ steps: [], nextTurn: [] })
  try {
    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    for (const text of ['первое', 'второе']) {
      await input.fill(text)
      await input.press('Enter')
      await expect(input).toHaveValue('')
    }
    await input.fill('черновик')
    await input.press('Home')
    await input.press('ArrowUp')
    await expect(input).toHaveValue('второе')
    await input.press('ArrowUp')
    await expect(input).toHaveValue('первое')
    await input.press('ArrowDown')
    await input.press('ArrowDown')
    await expect(input).toHaveValue('черновик')
  } finally {
    await close(app, profile)
  }
})

test('команда, отправленная из списка, тоже вспоминается по ↑', async () => {
  const { app, profile, win } = await launch({ steps: [], nextTurn: [] })
  try {
    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await input.fill('/compact')
    await input.press('Enter')
    await expect(win.locator('[data-testid="ribbon-user"]')).toContainText('/compact')
    await expect(input).toHaveValue('')
    await input.press('ArrowUp')
    await expect(input).toHaveValue('/compact')
  } finally {
    await close(app, profile)
  }
})

test('правка вызванного сообщения: ↓ возвращает исходный черновик', async () => {
  const { app, profile, win } = await launch({ steps: [], nextTurn: [] })
  try {
    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await input.fill('прошлое')
    await input.press('Enter')
    await expect(input).toHaveValue('')
    await input.fill('черновик')
    await input.press('Home')
    await input.press('ArrowUp')
    await expect(input).toHaveValue('прошлое')
    await input.press('End')
    await input.type('!')
    await expect(input).toHaveValue('прошлое!')
    await input.press('ArrowDown')
    await expect(input).toHaveValue('черновик')
  } finally {
    await close(app, profile)
  }
})

test('история вкладки — из её ленты, у второй вкладки своя', async () => {
  const other = mkdtempSync(join(tmpdir(), 'qclod-input-other-'))
  const { app, profile, win } = await launchWith(
    { steps: [{ kind: 'text', text: 'слушаю' }], nextTurn: [{ kind: 'text', text: 'готово' }] },
    { QCLOD_PICK_FOLDER: other }
  )
  try {
    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await input.fill('только в первой')
    await input.press('Enter')
    await expect(win.locator('[data-testid="ribbon-user"]')).toContainText('только в первой')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('готово', { timeout: 15000 })

    await win.locator('[data-testid="tab-new"]').click()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })
    await input.click()
    await input.press('ArrowUp')
    await expect(input).toHaveValue('')

    await win.locator('[data-testid="tab"]').first().click()
    await input.click()
    await input.press('ArrowUp')
    await expect(input).toHaveValue('только в первой')
  } finally {
    await close(app, profile)
    rmSync(other, { recursive: true, force: true })
  }
})

/** A first answer slow enough to type the next message into. */
const SLOW_FIRST_TURN = {
  steps: [],
  turns: [[{ kind: 'textStream', pieces: ['думаю ', 'ещё ', 'немного ', 'готово'], pauseMs: 700 }]],
  nextTurn: [{ kind: 'text', text: 'закоммитил' }]
}

async function sendWhileBusy(win: Page, first: string, next: string): Promise<void> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.click()
  await input.fill(first)
  await input.press('Enter')
  await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 15000 })
  await input.fill(next)
  await input.press('Enter')
  await expect(input).toHaveValue('')
}

const userBubbles = (win: Page) => win.locator('[data-testid="ribbon-user"]')

test('пока агент отвечает, Enter ставит сообщение в очередь; оно уходит само', async () => {
  const { app, profile, win } = await launch(SLOW_FIRST_TURN)
  try {
    await sendWhileBusy(win, 'сделай фичу', 'и потом закоммить')

    const queued = win.locator('[data-testid="queue-item"]')
    await expect(queued).toHaveText('Дойдёт после текущего шага: «и потом закоммить»')
    await expect(win.locator('[data-testid="queue-cancel"]')).toHaveAttribute('title', 'Убрать из очереди')
    // Not said yet: no bubble for it while it waits.
    await expect(userBubbles(win)).toHaveCount(1)

    await expect(userBubbles(win).nth(1)).toContainText('и потом закоммить', { timeout: 15000 })
    await expect(queued).toHaveCount(0)
    await expect(win.getByText('закоммитил')).toBeVisible({ timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('крестик убирает из очереди', async () => {
  const { app, profile, win } = await launch(SLOW_FIRST_TURN)
  try {
    await sendWhileBusy(win, 'сделай фичу', 'не надо этого')
    await expect(win.locator('[data-testid="queue-item"]')).toHaveCount(1)

    await win.locator('[data-testid="queue-cancel"]').click()
    await expect(win.locator('[data-testid="queue-item"]')).toHaveCount(0)

    // The turn ends and nothing more goes.
    await expect(win.locator('[data-testid="composer-send"]')).toBeVisible({ timeout: 15000 })
    await expect(win.getByText('закоммитил')).toHaveCount(0)
    await expect(userBubbles(win)).toHaveCount(1)
  } finally {
    await close(app, profile)
  }
})

test('Esc возвращает очередь в поле ввода', async () => {
  const { app, profile, win } = await launch(SLOW_FIRST_TURN)
  try {
    await sendWhileBusy(win, 'сделай фичу', 'и потом закоммить')
    await expect(win.locator('[data-testid="queue-item"]')).toHaveCount(1)

    const input = win.locator('[data-testid="composer-input"]')
    await input.fill('уже набрано')
    await input.press('Escape')

    // The waiting message comes back before what was typed, a blank line apart.
    await expect(input).toHaveValue('и потом закоммить\n\nуже набрано')
    await expect(win.locator('[data-testid="queue-item"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="composer-send"]')).toBeVisible({ timeout: 15000 })
    await expect(userBubbles(win)).toHaveCount(1)
  } finally {
    await close(app, profile)
  }
})
