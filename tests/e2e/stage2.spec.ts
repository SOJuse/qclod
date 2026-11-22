import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchQclod } from './helpers/launch'

// Этап 2 end to end (задача 19, шаг 3): what the lanes only proved apart.

const panesOf = (win: Page): Locator => win.locator('[data-testid="split-pane"]')
const order = (win: Page): Promise<string[]> =>
  panesOf(win).evaluateAll((els) => els.map((el) => el.getAttribute('data-pane') ?? ''))
const widths = (win: Page): Promise<number[]> =>
  panesOf(win).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))
const chats = (win: Page): Locator => win.locator('[data-testid="tab"]')
const pastSessions = (win: Page): Locator => win.locator('[data-testid="sidebar-session"]')

/** Drags a sidebar row onto a pane, `x` across it (0 = left edge, 1 = right edge). */
async function dragRow(row: Locator, pane: Locator, x: number): Promise<void> {
  const box = await pane.boundingBox()
  if (!box) throw new Error('у панели нет рамки')
  await row.dragTo(pane, { targetPosition: { x: Math.min(box.width - 4, Math.max(4, box.width * x)), y: box.height * 0.3 } })
}

/** Whether main still holds an agent session for the chat (manager.get), through the e2e seam. */
const hasSession = (app: ElectronApplication, id: string): Promise<boolean> =>
  app.evaluate((_electron, tabId) => {
    const seam = (globalThis as { __qclodHasSession?: (id: string) => boolean }).__qclodHasSession
    if (!seam) throw new Error('нет __qclodHasSession: не e2e-сборка')
    return seam(tabId)
  }, id)

test('сплит из трёх чатов переживает перезапуск: те же чаты, тот же порядок, ширины и активная панель', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'qclod-stage2-dir-'))
  const profile = mkdtempSync(join(tmpdir(), 'qclod-stage2-profile-'))
  const env = { QCLOD_USER_DATA: profile, QCLOD_PICK_FOLDER: folder }
  const size = { width: 1600, height: 900 }
  try {
    let saved: { order: string[]; widths: number[] }
    const first = await launchQclod({ env, size })
    try {
      const { win } = first
      for (let n = 2; n <= 3; n++) {
        await win.locator('[data-testid="tab-new"]').click()
        await expect(chats(win)).toHaveCount(n, { timeout: 15000 })
      }
      await win.locator('[data-testid="panel-close"]').click()
      const panes = panesOf(win)
      await expect(panes).toHaveCount(1)
      const ids = await chats(win).evaluateAll((els) => els.map((el) => el.getAttribute('data-tab') ?? ''))
      const shown = (await order(win))[0]!
      const others = ids.filter((id) => id !== shown)
      const row = (id: string): Locator => win.locator(`[data-testid="tab"][data-tab="${id}"]`)
      await dragRow(row(others[0]!), panes.last(), 0.97)
      await expect(panes).toHaveCount(2)
      await dragRow(row(others[1]!), panes.last(), 0.97)
      await expect(panes).toHaveCount(3)
      expect(await order(win)).toEqual([shown, others[0], others[1]])

      // Widths pulled by hand, the middle pane made active.
      const splitter = win.locator('[data-testid="pane-splitter"]').first()
      await splitter.focus()
      await win.keyboard.press('ArrowRight')
      await win.keyboard.press('ArrowRight')
      await panes.nth(1).locator('[data-testid="composer-input"]').click()
      await expect(panes.nth(1)).toHaveClass(/is-active/)
      saved = { order: await order(win), widths: await widths(win) }
      const file = join(profile, 'layout.json')
      await expect
        .poll(() => {
          if (!existsSync(file)) return null
          const l = JSON.parse(readFileSync(file, 'utf8')) as { panes: string[]; active: string; paneWidths: number[] }
          return { panes: l.panes, active: l.active, even: l.paneWidths.every((w) => Math.abs(w - 1 / 3) < 1e-6) }
        })
        .toEqual({ panes: saved.order, active: saved.order[1], even: false })
    } finally {
      await first.app.close()
    }

    const second = await launchQclod({ env, size })
    try {
      const { win } = second
      await expect(panesOf(win)).toHaveCount(3, { timeout: 15000 })
      expect(await order(win)).toEqual(saved.order)
      await expect(panesOf(win).nth(1)).toHaveClass(/is-active/)
      await expect
        .poll(async () => (await widths(win)).map((w, i) => Math.abs(w - saved.widths[i]!) <= 2))
        .toEqual([true, true, true])
      // Each pane has its live chat, nothing else was opened.
      await expect(chats(win)).toHaveCount(3)
      for (const id of saved.order) {
        await expect.poll(() => hasSession(second.app, id), { timeout: 15000 }).toBe(true)
      }
    } finally {
      await second.app.close()
    }
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('две панели, по открытой карточке в каждой: каждая отвечается в своей панели', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'qclod-stage2-dir-'))
  try {
    const { app, win } = await launchQclod({
      env: { QCLOD_PICK_FOLDER: folder },
      size: { width: 1600, height: 900 },
      script: {
        steps: [],
        nextTurn: [
          { kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } },
          { kind: 'text', text: 'готово' }
        ]
      }
    })
    try {
      await win.locator('[data-testid="tab-new"]').click()
      await expect(chats(win)).toHaveCount(2, { timeout: 15000 })
      await win.locator('[data-testid="toggle-split"]').click()
      const panes = win.locator('[data-testid="chat-pane"]')
      await expect(panes).toHaveCount(2)
      const left = panes.first()
      const right = panes.last()

      for (const pane of [left, right]) {
        await pane.locator('[data-testid="composer-input"]').click()
        await win.keyboard.type('запусти тесты')
        await win.keyboard.press('Enter')
        await expect(pane.locator('[data-testid="pinned-card"] [data-testid="permission-card"]')).toBeVisible({ timeout: 15000 })
      }
      // The keys and buttons wake 400 ms after a card shows.
      await win.waitForTimeout(500)

      // The right one is allowed: its card goes, the left one still waits.
      await right.locator('[data-testid="permission-allow"]').click()
      await expect(right.locator('[data-testid="pinned-card"]')).toHaveCount(0)
      await expect(right.locator('[data-testid="card-summary"]')).toContainText('Разрешено: Bash · npm test')
      await expect(right.locator('[data-testid="ribbon"]')).toContainText('готово', { timeout: 15000 })
      await expect(left.locator('[data-testid="pinned-card"] [data-testid="permission-card"]')).toBeVisible()
      await expect(left.locator('[data-testid="card-summary"]')).toHaveCount(0)

      // The left one is refused there, and only there.
      await left.locator('[data-testid="permission-deny"]').click()
      await left.locator('[data-testid="permission-deny-send"]').click()
      await expect(left.locator('[data-testid="pinned-card"]')).toHaveCount(0)
      await expect(left.locator('[data-testid="card-summary"]')).toContainText('Запрещено: Bash · npm test')
      await expect(right.locator('[data-testid="card-summary"]')).toHaveCount(1)
      await expect(right.locator('[data-testid="card-summary"]')).not.toContainText('Запрещено')
    } finally {
      await app.close()
    }
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 })
  }
})

const SESSION = 'сессия-этап-2'
const HISTORY = {
  sessions: [{ sessionId: SESSION, summary: 'Разговор до закрытия', lastModified: Date.now() - 60_000, firstPrompt: 'привет' }],
  messages: {
    [SESSION]: [
      { type: 'user', message: { role: 'user', content: 'привет' } },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ответ агента' }] } }
    ]
  }
}

test('«Закрыть чат»: сессия закрыта, строка ушла в «Прошлые»; клик по ней — снова живой чат с той же лентой', async () => {
  const { app, win } = await launchQclod({
    env: { QCLOD_FAKE_HISTORY: JSON.stringify(HISTORY) },
    script: { sessionId: SESSION, steps: [], nextTurn: [{ kind: 'text', text: 'ответ агента' }] }
  })
  try {
    await expect(chats(win)).toHaveCount(1)
    const id = (await chats(win).first().getAttribute('data-tab'))!
    await win.locator('[data-testid="composer-input"]').fill('привет')
    await win.keyboard.press('Enter')
    const ribbon = win.locator('[data-testid="ribbon"]')
    await expect(ribbon).toContainText('ответ агента', { timeout: 15000 })
    await expect.poll(() => hasSession(app, id)).toBe(true)
    // The open conversation is a chat, not a past one.
    await expect(pastSessions(win)).toHaveCount(0, { timeout: 15000 })

    await chats(win).first().locator('.tab-close').click()
    // Its session is closed; the window got a fresh chat in the same folder.
    await expect.poll(() => hasSession(app, id), { timeout: 15000 }).toBe(false)
    await expect(win.locator(`[data-testid="tab"][data-tab="${id}"]`)).toHaveCount(0)
    await expect(chats(win)).toHaveCount(1)
    await expect(pastSessions(win)).toHaveCount(1, { timeout: 15000 })
    await expect(pastSessions(win).first()).toContainText('Разговор до закрытия')

    await pastSessions(win).first().click()
    await expect(chats(win)).toHaveCount(2, { timeout: 15000 })
    await expect(pastSessions(win)).toHaveCount(0)
    const opened = win.locator('[data-testid="tab"].is-active')
    const reopened = (await opened.getAttribute('data-tab'))!
    await expect(ribbon).toContainText('привет', { timeout: 15000 })
    await expect(ribbon).toContainText('ответ агента')
    // Alive: it answers again, in the same ribbon.
    await win.locator('[data-testid="composer-input"]').fill('ещё раз')
    await win.keyboard.press('Enter')
    await expect(ribbon).toContainText('ещё раз', { timeout: 15000 })
    await expect(ribbon.getByText('ответ агента')).toHaveCount(2, { timeout: 15000 })
    await expect.poll(() => hasSession(app, reopened)).toBe(true)
  } finally {
    await app.close()
  }
})

test('правило «разрешить всё такое» для пути Windows: в permission-rules.json и в настройках — с обратными слэшами', async () => {
  const path = 'C:\проект\src\a.ts'
  const { app, win, profile } = await launchQclod({
    script: {
      steps: [
        { kind: 'thinking', text: 'думаю', ms: 1300 },
        { kind: 'askPermission', name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }
      ]
    }
  })
  try {
    await expect(win.locator('[data-testid="permission-card"]')).toContainText(path, { timeout: 15000 })
    await win.waitForTimeout(500)
    await win.locator('[data-testid="permission-allow-all"]').first().click()
    const file = join(profile, 'permission-rules.json')
    await expect
      .poll(() => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Array<{ target?: string }>) : []).map((r) => r.target))
      .toEqual([path])

    await win.keyboard.press('Control+,')
    await win.locator('[data-testid="settings-nav-permissions"]').click()
    await expect(win.locator('[data-testid="permission-rule"] .settings-rule-target')).toHaveText(path)
  } finally {
    await app.close()
  }
})
