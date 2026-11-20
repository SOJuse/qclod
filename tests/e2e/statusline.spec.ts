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

test('у поля всегда виден контекст; лимиты ниже 80 % — в панели и в подсказке, не в строке', async () => {
  const { app, profile } = await launch({ steps: [], contextPercent: 42 })
  try {
    const win = await app.firstWindow()
    const context = win.locator('[data-testid="status-context"]')
    await expect(context).toContainText('42%', { timeout: 15000 })
    await expect(context).toHaveAttribute('title', /Контекст: 84\s000 из 200\s000 токенов/)
    await expect(context.locator('[data-level]')).toHaveAttribute('data-level', 'ok')

    // 13 % and 38 %: the line stays quiet, the panel has them.
    const limits = win.locator('[data-testid="side-panel"] [data-testid="panel-limits"]')
    await expect(limits).toContainText('13%')
    await expect(limits).toContainText('38%')
    await expect(win.locator('[data-testid="status-limit-alert"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="status-limit-5h"], [data-testid="status-limit-7d"]')).toHaveCount(0)
    // A pane without its panel still has them: in the context meter's hint.
    await expect(context).toHaveAttribute('title', /Лимит на 5 часов: 13 %, сброс через/)
    await expect(context).toHaveAttribute('title', /Лимит на неделю: 38 %, сброс через/)

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
    // The tooltip says which mode it is, not only that there is one.
    await expect(mode).toHaveAttribute('title', 'Режим разрешений: план — Shift+Tab по кругу')
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

test('панель чата уже 760px — панель свёрнута, открытая вручную выдвигается поверх', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    const panel = win.locator('[data-testid="side-panel"]')
    await expect(panel).toBeVisible({ timeout: 15000 })
    await expect(panel).toHaveAttribute('data-mode', 'docked')

    // 1000 wide less the sidebar leaves the pane under 760.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 760))
    await expect(panel).toHaveCount(0)
    await expect(win.locator('[data-testid="status-model"]')).toBeVisible()

    // Opening it by hand in a narrow pane is honoured: it slides out over the conversation…
    await win.locator('[data-testid="panel-open"]').click()
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAttribute('data-mode', 'drawer')
    // …Esc puts it away, and so does a press past it.
    await win.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await win.locator('[data-testid="panel-open"]').click()
    await expect(panel).toHaveAttribute('data-mode', 'drawer')
    await win.locator('[data-testid="composer-input"]').click()
    await expect(panel).toHaveCount(0)

    // Not written into the settings: widening and narrowing again folds it.
    await win.locator('[data-testid="panel-open"]').click()
    await expect(panel).toHaveAttribute('data-mode', 'drawer')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 760))
    await expect(panel).toHaveAttribute('data-mode', 'docked')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 760))
    await expect(panel).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('лимит от 80 % — одна плашка, большее из окон; в узком окне она остаётся', async () => {
  const now = Math.floor(Date.now() / 1000)
  const { app, profile } = await launch({
    steps: [],
    rateLimits: { fiveHour: { utilization: 0.85, resetsAt: now + 3600 }, sevenDay: { utilization: 0.91, resetsAt: now + 3 * 86400 } }
  })
  try {
    const win = await app.firstWindow()
    const chip = win.locator('[data-testid="status-limit-alert"]')
    await expect(chip).toHaveText('Неделя: 91 %', { timeout: 15000 })
    await expect(chip).toHaveAttribute('title', /^Лимит на неделю: 91 %, сброс через \d+ дн$/)
    await expect(chip.locator('[data-level-icon="critical"]')).toHaveCount(1)

    // The smallest window: the panel folds, the line drops its lists — the chip stays.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 600))
    await expect(win.locator('[data-testid="side-panel"]')).toHaveCount(0)
    await expect(chip).toBeVisible()
    await expect(win.locator('[data-testid="status-context"]')).toHaveAttribute('title', /Лимит на 5 часов: 85 %/)
  } finally {
    await close(app, profile)
  }
})

/** Everything that stands above the input at once: todos, the «now» line, the context banner, a queue of three. */
const FULL_DOCK = {
  steps: [],
  contextPercent: 93,
  turns: [
    [
      {
        kind: 'todo',
        items: [
          { content: 'разобрать ленту', status: 'completed', activeForm: 'разбираю ленту' },
          { content: 'собрать панель', status: 'in_progress', activeForm: 'собираю панель' },
          { content: 'проверить', status: 'pending', activeForm: 'проверяю' }
        ]
      },
      { kind: 'textStream', pieces: ['думаю ', 'ещё ', 'долго'], pauseMs: 20000 }
    ]
  ]
}

test('S2-R23 (б): в 800×600 док со всем открытым не налезает на шапку, поле и строка статуса видны', async () => {
  const { app, profile } = await launch(FULL_DOCK)
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 600))
    await send(win, 'сделай фичу')
    await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 15000 })
    for (const text of ['первое в очередь', 'второе в очередь', 'третье в очередь']) await send(win, text)
    await expect(win.locator('[data-testid="queue-item"]')).toHaveCount(3, { timeout: 15000 })
    await expect(win.locator('[data-testid="context-banner"]')).toBeVisible()
    await expect(win.locator('[data-testid="todo-strip"]')).toBeVisible()

    const box = async (sel: string) => (await win.locator(sel).boundingBox())!
    const fits = async (): Promise<void> => {
      const header = await box('[data-testid="chat-header"]')
      const dock = await box('[data-testid="composer-dock"]')
      const field = await box('.composer-row')
      const line = await box('[data-testid="status-line"]')
      const view = await win.evaluate(() => window.innerHeight)
      // Below the header, and the input and its status line inside the window and the dock.
      expect(dock.y).toBeGreaterThanOrEqual(header.y + header.height)
      expect(field.y).toBeGreaterThanOrEqual(dock.y)
      expect(line.y + line.height).toBeLessThanOrEqual(dock.y + dock.height + 1)
      expect(line.y + line.height).toBeLessThanOrEqual(view)
    }
    await fits()

    // More cards than the pane has room for (этап 2's cards move here): the cards and queue part
    // scrolls, the dock stays under the header, the input and the status line stay in view.
    const scroll = win.locator('[data-testid="composer-dock-scroll"]')
    await scroll.evaluate((el) => {
      const tall = document.createElement('div')
      tall.style.height = '900px'
      el.prepend(tall)
    })
    await fits()
    expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  } finally {
    await close(app, profile)
  }
})
