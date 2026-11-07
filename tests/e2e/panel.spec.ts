import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
    // The picker shows what a person reads and carries the id as its value.
    await expect(panel.locator('[data-testid="panel-model"]')).toHaveValue('claude-opus-5')
    await expect(panel.locator('[data-testid="panel-model"]')).toContainText('Opus 5')
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
