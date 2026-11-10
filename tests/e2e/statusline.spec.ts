import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(script: unknown): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-status-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(script)
    } as Record<string, string>
  })
  return { app, profile }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

/** Opens one of the status line's lists and picks the row with this id. */
async function choose(win: Page, testId: string, value: string): Promise<void> {
  await win.locator(`[data-testid="${testId}"]`).click()
  await win.locator(`[data-testid="${testId}-option"][data-id="${value}"]`).click()
}

async function send(win: Page, text: string): Promise<void> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

test('у поля всегда видны контекст и оба лимита', async () => {
  const { app, profile } = await launch({ steps: [], contextPercent: 42 })
  try {
    const win = await app.firstWindow()
    const context = win.locator('[data-testid="status-context"]')
    await expect(context).toContainText('42%', { timeout: 15000 })
    await expect(context).toHaveAttribute('title', /Контекст: 84\s000 из 200\s000 токенов/)
    await expect(context.locator('[data-level]')).toHaveAttribute('data-level', 'ok')

    await expect(win.locator('[data-testid="status-limit-5h"]')).toContainText('5 ч')
    await expect(win.locator('[data-testid="status-limit-5h"]')).toContainText('13%')
    await expect(win.locator('[data-testid="status-limit-7d"]')).toContainText('нед')
    await expect(win.locator('[data-testid="status-limit-7d"]')).toContainText('38%')
    await expect(win.locator('[data-testid="status-limit-5h"]')).toHaveAttribute('title', /Сброс через/)

    // Right by the input, below it — not up in the side panel.
    const line = await win.locator('[data-testid="status-line"]').boundingBox()
    const field = await win.locator('.composer-row').boundingBox()
    expect(line && field).toBeTruthy()
    expect(line!.y).toBeGreaterThanOrEqual(field!.y + field!.height)
    expect(line!.y - (field!.y + field!.height)).toBeLessThan(24)
  } finally {
    await close(app, profile)
  }
})

test('80% — индикатор меняет уровень, 92% — плашка «Сжать сейчас» отправляет /compact', async () => {
  const { app, profile } = await launch({
    steps: [],
    contextPercent: 10,
    contextPercentByTurn: [82, 92]
  })
  try {
    const win = await app.firstWindow()
    const meter = win.locator('[data-testid="status-context"] [data-level]')
    await expect(meter).toHaveAttribute('data-level', 'ok', { timeout: 15000 })

    await send(win, 'первый')
    await expect(meter).toHaveAttribute('data-level', 'warn', { timeout: 15000 })
    await expect(win.locator('[data-testid="status-context"]')).toContainText('82%')
    await expect(win.locator('[data-testid="status-context-alert"]')).toBeVisible()
    await expect(win.locator('[data-testid="context-banner"]')).toHaveCount(0)
    // The panel's bar follows the same thresholds as the status line.
    await expect(win.locator('[data-testid="panel-context"]')).toHaveAttribute('data-level', 'warn')

    await send(win, 'второй')
    await expect(meter).toHaveAttribute('data-level', 'critical', { timeout: 15000 })
    const banner = win.locator('[data-testid="context-banner"]')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Контекст почти заполнен — 92%')
    await expect(win.locator('[data-testid="panel-context"]')).toHaveAttribute('data-level', 'critical')

    await win.locator('[data-testid="context-compact"]').click()
    await expect(win.locator('[data-testid="ribbon-user"]').last()).toContainText('/compact', {
      timeout: 15000
    })
  } finally {
    await close(app, profile)
  }
})

test('модель, усилие и режим меняются из строки статуса', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    const model = win.locator('[data-testid="status-model"]')
    await expect(model).toHaveAttribute('data-value', 'claude-opus-5', { timeout: 15000 })
    await expect(model).toContainText('Opus 5')

    await choose(win, 'status-model', 'claude-sonnet-5')
    await expect(model).toHaveAttribute('data-value', 'claude-sonnet-5', { timeout: 15000 })
    await expect(model).toContainText('Sonnet 5')
    // The panel, open in a wide window, agrees.
    await expect(win.locator('[data-testid="side-panel"] [data-testid="panel-model"]')).toContainText(
      'Sonnet 5'
    )

    // Sonnet offers three levels where Opus offers five.
    await win.locator('[data-testid="status-effort"]').click()
    await expect(win.locator('[data-testid="status-effort-option"]')).toHaveCount(3)
    await win.locator('[data-testid="status-effort-option"][data-id="low"]').click()
    await expect(win.locator('[data-testid="status-effort"]')).toHaveAttribute('data-value', 'low', {
      timeout: 15000
    })

    const mode = win.locator('[data-testid="status-mode"]')
    await choose(win, 'status-mode', 'plan')
    await expect(mode).toHaveAttribute('data-value', 'plan', { timeout: 15000 })
    await expect(mode).toContainText('план')
  } finally {
    await close(app, profile)
  }
})

test('список строки статуса водится с клавиатуры', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    const mode = win.locator('[data-testid="status-mode"]')
    await expect(mode).toHaveAttribute('data-value', 'default', { timeout: 15000 })

    // A select-only combobox: the list is its popup and the chosen row its active descendant.
    await expect(mode).toHaveAttribute('role', 'combobox')
    await expect(mode).toHaveAttribute('aria-expanded', 'false')

    // Esc reaching the window: an open list keeps it, a closed button lets it through.
    await win.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { escSeen: string[] }).escSeen = seen
      window.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') seen.push(ev.defaultPrevented ? 'prevented' : 'free')
      })
    })
    const escSeen = (): Promise<string[]> =>
      win.evaluate(() => (window as unknown as { escSeen: string[] }).escSeen)

    await mode.focus()
    await win.keyboard.press('Enter')
    await expect(win.locator('[data-testid="status-mode-menu"]')).toBeVisible()
    await expect(mode).toHaveAttribute('aria-expanded', 'true')
    const active = await mode.getAttribute('aria-activedescendant')
    expect(active).toBeTruthy()
    await expect(win.locator(`[id="${active}"]`)).toHaveAttribute('data-id', 'default')
    await win.keyboard.press('Escape')
    await expect(win.locator('[data-testid="status-mode-menu"]')).toHaveCount(0)
    expect(await escSeen()).toEqual([])

    await win.keyboard.press('Escape')
    expect(await escSeen()).toEqual(['free'])

    // default → acceptEdits → plan, one row down at a time.
    await win.keyboard.press('ArrowUp')
    await expect(win.locator('[data-testid="status-mode-menu"]')).toBeVisible()
    await win.keyboard.press('ArrowDown')
    await win.keyboard.press('ArrowDown')
    await win.keyboard.press('Enter')
    await expect(mode).toHaveAttribute('data-value', 'plan', { timeout: 15000 })
    await expect(win.locator('[data-testid="status-mode-menu"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('усилие, которого новая модель не знает, показано как «как у модели», а не кодом', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    const effort = win.locator('[data-testid="status-effort"]')
    await expect(win.locator('[data-testid="status-model"]')).toHaveAttribute('data-value', 'claude-opus-5', {
      timeout: 15000
    })
    await choose(win, 'status-effort', 'xhigh')
    await expect(effort).toHaveAttribute('data-value', 'xhigh', { timeout: 15000 })

    // Sonnet has no «очень высокое».
    await choose(win, 'status-model', 'claude-sonnet-5')
    await expect(win.locator('[data-testid="status-model"]')).toHaveAttribute('data-value', 'claude-sonnet-5')
    await expect(effort).toHaveText('как у модели')
    await expect(effort).not.toContainText('xhigh')

    await effort.click()
    const rows = win.locator('[data-testid="status-effort-option"]')
    await expect(rows).toHaveCount(3)
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
  } finally {
    await close(app, profile)
  }
})

test('окно уже 1100px — панель свёрнута, переключатели в строке статуса', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible({ timeout: 15000 })

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 760))
    await expect(win.locator('[data-testid="side-panel"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="status-model"]')).toBeVisible()

    // Opening it by hand in a narrow window is honoured…
    await win.locator('[data-testid="panel-open"]').click()
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()

    // …and is not written into the settings: widening and narrowing again folds it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 760))
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 760))
    await expect(win.locator('[data-testid="side-panel"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})
