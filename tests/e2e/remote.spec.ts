import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A card takes focus only after the window has been in front a while; the turn rests first. */
const SETTLE = { kind: 'thinking', text: 'думаю', ms: 1300 }

const SESSION_URL = 'https://claude.ai/code/session_fake0001'

async function launch(script: Record<string, unknown>): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-remote-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({ steps: [], ...script })
    } as Record<string, string>
  })
  return { app, profile }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

async function ready(win: Page): Promise<ReturnType<Page['locator']>> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.waitFor({ timeout: 15000 })
  await input.click()
  return input
}

/** Hides the side panel, so a test can see the switch bring it back. */
async function hidePanel(win: Page): Promise<void> {
  await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()
  await win.locator('[data-testid="panel-close"]').click()
  await expect(win.locator('[data-testid="side-panel"]')).toHaveCount(0)
}

async function showPanel(win: Page): Promise<void> {
  const open = win.locator('[data-testid="panel-open"]')
  if (await open.isVisible()) await open.click()
  await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()
}

/** The status-line switch, once the session is up and has said whether it may. */
async function toggle(win: Page): Promise<void> {
  const button = win.locator('[data-testid="remote-toggle"]')
  await expect(button).toBeEnabled({ timeout: 15000 })
  await button.click()
}

test('кнопка включает Remote Control: значок на вкладке, ссылка и QR в панели, «Выключить» гасит', async () => {
  const { app, profile } = await launch({})
  try {
    const win = await app.firstWindow()
    await ready(win)
    await expect(win.locator('[data-testid="tab-remote"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="remote-toggle"]')).toHaveAttribute(
      'title',
      'Remote Control: продолжить эту сессию с телефона или claude.ai'
    )
    await hidePanel(win)

    await toggle(win)

    // Turning it on shows the panel, where the link is.
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()
    await expect(win.locator('[data-testid="tab-remote"]')).toHaveAttribute('data-state', 'on')
    await expect(win.locator('[data-testid="remote-toggle"]')).toHaveAttribute('data-state', 'on')
    await expect(win.locator('[data-testid="remote-toggle"]')).toContainText('на связи')
    const panel = win.locator('[data-testid="panel-remote"]')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('на связи')
    await expect(win.locator('[data-testid="remote-link"]')).toContainText(SESSION_URL)
    const qr = win.locator('[data-testid="remote-qr"]')
    await expect(qr).toBeVisible()
    await expect(qr).toHaveAttribute('aria-label', 'QR-код ссылки на сессию')
    await expect(qr.locator('path')).toHaveCount(1)
    await expect(panel).toContainText('Наведите камеру телефона или откройте ссылку на claude.ai.')
    await expect(panel).toContainText('Закроете вкладку — сессия на телефоне станет недоступна.')
    await expect(win.locator('[data-testid="remote-open"]')).toHaveText('Открыть в браузере')

    // The section leads the panel while the bridge is on.
    const first = win.locator('[data-testid="side-panel"] .panel-section').first()
    await expect(first).toHaveAttribute('data-testid', 'panel-remote')

    // The QR is square, and the link stays inside the panel.
    const box = await qr.boundingBox()
    expect(box && Math.round(box.width)).toBe(168)
    expect(box && Math.round(box.height)).toBe(168)
    const panelBox = await win.locator('[data-testid="side-panel"]').boundingBox()
    const linkBox = await win.locator('[data-testid="remote-link"]').boundingBox()
    expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width)
    // A 268 px panel has no room beside the QR: the hint goes under it.
    const hintBox = await win.locator('[data-testid="remote-hint"]').boundingBox()
    expect(hintBox!.y).toBeGreaterThanOrEqual(box!.y + box!.height)
    await win.screenshot({ path: 'tests/.artifacts/remote/panel-on.png' })

    await win.locator('[data-testid="remote-off"]').click()
    await expect(win.locator('[data-testid="tab-remote"]')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Включить' })).toBeVisible()
    await expect(win.locator('[data-testid="remote-qr"]')).toHaveCount(0)
    // Off, the section moves to the end of the panel.
    const last = win.locator('[data-testid="side-panel"] .panel-section').last()
    await expect(last).toHaveAttribute('data-testid', 'panel-remote')
  } finally {
    await close(app, profile)
  }
})

test('/remote-control в поле ввода — тот же переключатель', async () => {
  const { app, profile } = await launch({})
  try {
    const win = await app.firstWindow()
    const input = await ready(win)
    await expect(win.locator('[data-testid="remote-toggle"]')).toBeEnabled({ timeout: 15000 })
    await hidePanel(win)
    await input.click()

    await input.pressSequentially('/remote-control')
    await input.press('Enter')

    await expect(win.locator('[data-testid="tab-remote"]')).toHaveAttribute('data-state', 'on')
    await expect(input).toHaveValue('')
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="panel-remote"]')).toBeVisible()

    // Typed whole with the list closed, it still never reaches the session.
    await input.pressSequentially('/rc')
    await input.press('Escape')
    await input.press('Enter')
    await expect(win.locator('[data-testid="tab-remote"]')).toHaveCount(0)
    await expect(input).toHaveValue('')
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('сообщение с телефона — пузырь человека с пометкой и ответ агента', async () => {
  const { app, profile } = await launch({
    remoteControl: {
      phoneTurns: [{ text: 'проверь тесты', afterMs: 300, steps: [{ kind: 'text', text: 'тесты зелёные' }] }]
    }
  })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await toggle(win)

    const bubble = win.locator('[data-testid="ribbon-user"]', { hasText: 'проверь тесты' })
    await expect(bubble).toBeVisible({ timeout: 15000 })
    const mark = bubble.locator('[data-testid="user-from-phone"]')
    await expect(mark).toHaveText('с телефона')
    await expect(mark).toHaveAttribute('title', 'Написано через Remote Control — с телефона или claude.ai')
    await expect(win.locator('[data-testid="ribbon-agentText"]', { hasText: 'тесты зелёные' })).toBeVisible()
  } finally {
    await close(app, profile)
  }
})

test('разрешение, на которое ответили с телефона, закрывается в Qclod', async () => {
  const { app, profile } = await launch({
    nextTurn: [
      SETTLE,
      { kind: 'remoteAnswer', name: 'Bash', input: { command: 'npm test' }, decision: 'allow', afterMs: 1500 }
    ]
  })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)
    await toggle(win)
    await expect(win.locator('[data-testid="tab-remote"]')).toHaveAttribute('data-state', 'on')

    await input.fill('запусти тесты')
    await input.press('Enter')

    const card = win.locator('[data-testid="pinned-card"] [data-testid="permission-card"]')
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(win.locator('[data-testid="permission-allow"]')).toBeVisible()
    // Answered there: it leaves the pinned strip, and the ribbon says where it was answered.
    const summary = win.locator('[data-testid="card-summary"]')
    await expect(summary).toContainText('Ответили с телефона: Bash · npm test', { timeout: 10000 })
    await expect(win.locator('[data-testid="pinned-card"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="permission-allow"]')).toHaveCount(0)
    await expect(summary).not.toContainText('Запрещено')
  } finally {
    await close(app, profile)
  }
})

test('вход по API-ключу: кнопка неактивна и объясняет почему', async () => {
  const { app, profile } = await launch({ remoteControl: { blocked: 'api_key' } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)

    const button = win.locator('[data-testid="remote-toggle"]')
    await expect(button).toBeDisabled({ timeout: 15000 })
    await expect(button).toHaveAttribute('title', /только при входе через подписку claude\.ai/)
    await showPanel(win)
    const panel = win.locator('[data-testid="panel-remote"]')
    await expect(panel).toContainText('только при входе через подписку claude.ai')
    await expect(panel.getByRole('button', { name: 'Включить' })).toHaveCount(0)

    await input.click()
    await input.pressSequentially('/remote')
    const item = win.locator('[data-testid="slash-item"]', { hasText: 'remote-control' })
    await expect(item).toHaveAttribute('aria-disabled', 'true')
    await expect(item).toContainText('только при входе через подписку claude.ai')
  } finally {
    await close(app, profile)
  }
})

test('мост потерял связь — значок красный, причина в панели', async () => {
  const { app, profile } = await launch({
    remoteControl: { bridge: [{ state: 'connected' }, { state: 'failed', detail: 'таймаут', afterMs: 300 }] }
  })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await toggle(win)

    await expect(win.locator('[data-testid="tab-remote"]')).toHaveAttribute('data-state', 'failed')
    await expect(win.locator('[data-testid="tab"]').first()).toHaveAttribute('title', /Remote Control: нет связи/)
    await expect(win.locator('[data-testid="panel-remote"]')).toContainText('Связь с claude.ai потеряна. таймаут')
    // Failed, the switch can turn it on again.
    await expect(win.locator('[data-testid="panel-remote"]').getByRole('button', { name: 'Включить' })).toBeVisible()
  } finally {
    await close(app, profile)
  }
})
