import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(
  script: unknown,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-panel-'))
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

/** Opens one of the status line's lists and picks the row with this id. */
async function choose(win: Page, testId: string, value: string): Promise<void> {
  await win.locator(`[data-testid="${testId}"]`).click()
  await win.locator(`[data-testid="${testId}-option"][data-id="${value}"]`).click()
}

test('панель показывает контекст, лимиты, модель и MCP', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'text', text: 'готово' }],
    contextPercent: 37,
    costUsd: 0.1234,
    init: {
      model: 'claude-opus-5',
      mcpServers: [
        { name: 'plugin:github:github', status: 'needs-auth' },
        { name: 'unity-mcp', status: 'connected' }
      ]
    },
    rateLimits: {
      fiveHour: { utilization: 0.13, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
      sevenDay: { utilization: 0.38, resetsAt: Math.floor(Date.now() / 1000) + 400000 }
    }
  })
  try {
    const win = await app.firstWindow()
    const panel = win.locator('[data-testid="side-panel"]')
    await expect(panel).toBeVisible({ timeout: 15000 })

    await expect(panel.locator('[data-testid="panel-context"]')).toContainText('37%', {
      timeout: 15000
    })
    // The panel names the model as a person reads it; switching is in the status line.
    await expect(panel.locator('[data-testid="panel-model"]')).toContainText('Opus 5')
    await expect(win.locator('[data-testid="status-model"]')).toHaveAttribute('data-value', 'claude-opus-5')
    await expect(panel.locator('[data-testid="panel-cost"]')).toContainText('$0.1234')

    // Both subscription windows — the thing the first spec draft said was
    // unreachable and the probe proved otherwise.
    const limits = panel.locator('[data-testid="panel-limits"]')
    await expect(limits).toContainText('13%')
    await expect(limits).toContainText('38%')
    await expect(limits).toContainText('сброс')

    // Four MCP states, not two: «требует входа» is real.
    const mcp = panel.locator('[data-testid="panel-mcp"]')
    await expect(mcp).toContainText('требует входа')
    await expect(mcp).toContainText('подключён')
  } finally {
    await close(app, profile)
  }
})

test('пустые данные показываются как «появится после запуска», а не нулями', async () => {
  // A folder that no longer exists: no session starts, so there is nothing to
  // report — and nothing must be invented.
  const gone = join(mkdtempSync(join(tmpdir(), 'qclod-gone-')), 'нет-такой-папки')

  const profile = mkdtempSync(join(tmpdir(), 'qclod-panel-'))
  writeFileSync(
    join(profile, 'tabs.json'),
    JSON.stringify([{ id: 'a', cwd: gone, title: 'Пропавшая', overrides: {} }]),
    'utf8'
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({ steps: [] })
    } as Record<string, string>
  })
  try {
    const win = await app.firstWindow()
    const panel = win.locator('[data-testid="side-panel"]')
    await expect(panel).toBeVisible({ timeout: 15000 })

    await expect(panel.locator('[data-testid="panel-empty"]').first()).toContainText(
      'появится после запуска'
    )
    await expect(panel).not.toContainText('0%')
    await expect(panel).not.toContainText('$0.00')
  } finally {
    await close(app, profile)
  }
})

test('панель складывается хоткеем и помнит состояние', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible({ timeout: 15000 })

    await win.keyboard.press('Control+Backslash')
    await expect(win.locator('[data-testid="side-panel"]')).toHaveCount(0)

    await win.locator('[data-testid="panel-open"]').click()
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()

    await win.locator('[data-testid="panel-close"]').click()
    await expect(win.locator('[data-testid="side-panel"]')).toHaveCount(0)

    // Closed stays closed across restarts.
    await app.close()
    const again = await electron.launch({
      args: ['.'],
      env: { ...process.env, QCLOD_USER_DATA: profile } as Record<string, string>
    })
    const win2 = await again.firstWindow()
    await win2.locator('[data-testid="panel-open"]').waitFor({ timeout: 15000 })
    await expect(win2.locator('[data-testid="side-panel"]')).toHaveCount(0)
    await again.close()
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('свои хуки папки показаны отдельной строкой', async () => {
  // Project settings load with no trust gate — the user's explicit choice
  // (spec §5). This row is the agreed mitigation: the choice is visible.
  const project = mkdtempSync(join(tmpdir(), 'qclod-hooked-'))
  mkdirSync(join(project, '.claude'))
  writeFileSync(
    join(project, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: 'echo раз' }, { command: 'echo два' }] }] },
      mcpServers: { 'сервер-проекта': {} }
    }),
    'utf8'
  )

  const profile = mkdtempSync(join(tmpdir(), 'qclod-panel-'))
  writeFileSync(
    join(profile, 'tabs.json'),
    JSON.stringify([{ id: 'a', cwd: project, title: 'С хуками', overrides: {} }]),
    'utf8'
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({ steps: [] })
    } as Record<string, string>
  })
  try {
    const win = await app.firstWindow()
    const row = win.locator('[data-testid="panel-project-settings"]')

    await expect(row).toBeVisible({ timeout: 15000 })
    await expect(row).toContainText('2')
    await expect(row).toContainText('сервер-проекта')
  } finally {
    await close(app, profile)
    rmSync(project, { recursive: true, force: true })
  }
})

test('пока модель неизвестна, выбор показывает «…», потом настоящую', async () => {
  // steps: [] — silent until the first message, like the real CLI. The model
  // is known only once getContextUsage answers, and that answer is delayed.
  const { app, profile } = await launch({ steps: [], contextUsageDelayMs: 1500 })
  try {
    const win = await app.firstWindow()
    // The list of models comes long before the delayed context answer: the
    // button can open, but which model is on is not known yet.
    const picker = win.locator('[data-testid="status-model"]')
    await expect(picker).toBeEnabled({ timeout: 15000 })
    await expect(picker).toHaveAttribute('data-value', '')
    await expect(picker).toHaveText('…')

    await expect(picker).toHaveAttribute('data-value', 'claude-opus-5', { timeout: 15000 })
    await expect(picker).toHaveText('Opus 5')

    // Nothing was sent to get there.
    await expect(win.locator('[data-testid="side-panel"] [data-testid="panel-limits"]')).toContainText(
      '13%'
    )
  } finally {
    await close(app, profile)
  }
})

test('после перезагрузки окна панель снова полная', async () => {
  // steps: [] — nothing is sent, so nothing after the reload can refill the
  // panel by events: only the snapshot the window asks for.
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    const panel = win.locator('[data-testid="side-panel"]')
    await expect(panel.locator('[data-testid="panel-context"]')).toContainText('21%', {
      timeout: 15000
    })
    await expect(panel.locator('[data-testid="panel-model"]')).toContainText('Opus 5', {
      timeout: 15000
    })

    await win.reload()

    const again = win.locator('[data-testid="side-panel"]')
    await expect(again).toBeVisible({ timeout: 15000 })
    await expect(again.locator('[data-testid="panel-context"]')).toContainText('21%', {
      timeout: 15000
    })
    await expect(again.locator('[data-testid="panel-model"]')).toContainText('Opus 5')
    await expect(win.locator('[data-testid="status-model"]')).toHaveAttribute('data-value', 'claude-opus-5')
    await expect(again.locator('[data-testid="panel-limits"]')).toContainText('13%')
  } finally {
    await close(app, profile)
  }
})

test('модель и усилие вкладки переживают перезапуск приложения', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    const model = win.locator('[data-testid="status-model"]')
    const effort = win.locator('[data-testid="status-effort"]')
    await expect(model).toHaveAttribute('data-value', 'claude-opus-5', { timeout: 15000 })

    await choose(win, 'status-model', 'claude-sonnet-5')
    await expect(model).toHaveAttribute('data-value', 'claude-sonnet-5')
    await choose(win, 'status-effort', 'low')
    await expect(effort).toHaveAttribute('data-value', 'low')
    // Both are written to disk before the app is closed.
    await expect
      .poll(() => readFileSync(join(profile, 'tabs.json'), 'utf8'), { timeout: 10000 })
      .toContain('claude-sonnet-5')
    await app.close()

    const again = await electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        QCLOD_USER_DATA: profile,
        QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({ steps: [] })
      } as Record<string, string>
    })
    try {
      const win2 = await again.firstWindow()
      await expect(win2.locator('[data-testid="status-model"]')).toHaveAttribute(
        'data-value',
        'claude-sonnet-5',
        { timeout: 15000 }
      )
      await expect(win2.locator('[data-testid="status-effort"]')).toHaveAttribute('data-value', 'low')
    } finally {
      await again.close().catch(() => undefined)
    }
  } finally {
    await close(app, profile)
  }
})

test('разбивка контекста — одна полоса и легенда', async () => {
  const { app, profile } = await launch({ steps: [{ kind: 'text', text: 'готово' }], contextPercent: 21 })
  try {
    const win = await app.firstWindow()
    const context = win.locator('[data-testid="panel-context"]')
    await expect(context).toContainText('21%', { timeout: 15000 })

    const bar = context.locator('[data-testid="context-bar"]')
    await expect(bar).toHaveCount(1)
    await expect(bar).toHaveAttribute('role', 'img')
    await expect(bar).toHaveAttribute('aria-label', /Сообщения.*Системный промпт.*Резерв сжатия.*Свободно/)
    // used x2, reserve, free; the deferred row is not drawn.
    await expect(bar.locator('.context-seg')).toHaveCount(4)

    const rows = context.locator('[data-testid="context-legend-row"]')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText('Сообщения')
    await expect(rows.nth(1)).toContainText('Системный промпт')
    await expect(rows.nth(2)).toContainText('Резерв сжатия')
    await expect(rows.nth(3)).toContainText('Свободно')
    await expect(context.locator('[data-testid="context-legend"]')).not.toContainText('deferred')

    // The swatches must be big enough to show the hatch of the reserve.
    const box = await rows.nth(2).locator('.context-swatch').boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(12)
    expect(box!.height).toBeGreaterThanOrEqual(10)
    // The reserve is thin but must stay visible in the bar.
    const seg = await bar.locator('.context-seg[data-fill="seg-buffer"]').boundingBox()
    expect(seg!.width).toBeGreaterThanOrEqual(8)
  } finally {
    await close(app, profile)
  }
})
