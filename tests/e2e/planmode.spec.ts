import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(
  script: unknown,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-plan-'))
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

const PLAN = 'Разобрать auth.ts на три модуля и перенести тесты'

test('режим переключается из панели и хоткеем по кругу', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    const mode = win.locator('[data-testid="panel-mode"]')
    await expect(mode).toHaveValue('default', { timeout: 15000 })

    await mode.selectOption('plan')
    await expect(mode).toHaveValue('plan', { timeout: 15000 })

    // Shift+Tab walks the everyday modes, as it does in the terminal.
    await win.locator('[data-testid="composer-input"]').click()
    await win.keyboard.press('Shift+Tab')
    await expect(mode).toHaveValue('default', { timeout: 15000 })

    await win.keyboard.press('Shift+Tab')
    await expect(mode).toHaveValue('acceptEdits', { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('выбранный режим переживает перезапуск вкладки', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    const mode = win.locator('[data-testid="panel-mode"]')
    await expect(mode).toHaveValue('default', { timeout: 15000 })

    await mode.selectOption('acceptEdits')
    await expect(mode).toHaveValue('acceptEdits')

    // A fresh init reports the SDK's own mode; ours must not be overruled.
    await win.locator('[data-testid="composer-input"]').click()
    await win.locator('[data-testid="composer-input"]').fill('работай')
    await win.locator('[data-testid="composer-input"]').press('Enter')

    await expect(mode).toHaveValue('acceptEdits', { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('в режиме плана агент показывает план и ждёт подтверждения', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'askPermission', name: 'ExitPlanMode', input: { plan: PLAN } }]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="plan-card"]')

    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card.locator('[data-testid="plan-text"]')).toContainText(PLAN)

    // Nothing runs while the plan is unanswered.
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="tab"] .tab-status')).toHaveClass(/is-waiting/)
  } finally {
    await close(app, profile)
  }
})

test('подтверждение плана переводит в рабочий режим и агент продолжает', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'askPermission', name: 'ExitPlanMode', input: { plan: PLAN } },
      { kind: 'text', text: 'приступаю' }
    ]
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="plan-approve"]').click({ timeout: 15000 })

    await expect(win.locator('[data-testid="plan-card"]')).toContainText('принят')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('приступаю', {
      timeout: 15000
    })

    // Staying in plan mode would stop the agent doing what was just approved.
    await expect(win.locator('[data-testid="panel-mode"]')).toHaveValue('acceptEdits', {
      timeout: 15000
    })
  } finally {
    await close(app, profile)
  }
})

test('отклонение плана возвращает к обсуждению, ничего не выполнив', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'askPermission', name: 'ExitPlanMode', input: { plan: PLAN } },
      { kind: 'text', text: 'хорошо, подумаю ещё' }
    ]
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="plan-reject"]').click({ timeout: 15000 })

    await expect(win.locator('[data-testid="plan-card"]')).toContainText('отклонён')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('хорошо, подумаю ещё', {
      timeout: 15000
    })
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('«без проверок» требует подтверждения вне окна', async () => {
  // Without the confirmation answered, the mode must not change: this one
  // turns Qclod's own gate off entirely.
  const { app, profile } = await launch({ steps: [] }, { QCLOD_CONFIRM_BYPASS: 'deny' })
  try {
    const win = await app.firstWindow()
    const mode = win.locator('[data-testid="panel-mode"]')
    await expect(mode).toHaveValue('default', { timeout: 15000 })

    await mode.selectOption('bypassPermissions')

    // The select shows what the panel reports, and the panel reports what the
    // session actually has — which is still «спрашивать».
    await expect(mode).toHaveValue('default', { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})
