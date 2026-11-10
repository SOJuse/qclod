import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(script: unknown): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-bg-'))
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

async function send(win: Page, text: string): Promise<void> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

test('фоновая команда видна в строке статуса, вывод растёт, «Остановить» останавливает', async () => {
  const { app, profile } = await launch({
    steps: [],
    nextTurn: [
      {
        kind: 'backgroundBash',
        command: 'npm run dev',
        chunks: ['готово 1\n', 'готово 2\n'],
        pauseMs: 300,
        finish: null
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    // Nothing in the background yet: no counter at all.
    await expect(win.locator('[data-testid="status-context"]')).toBeVisible({ timeout: 15000 })
    await expect(win.locator('[data-testid="status-bg"]')).toHaveCount(0)

    await send(win, 'запусти сервер')
    const counter = win.locator('[data-testid="status-bg"]')
    await expect(counter).toHaveText('Фоновые 1', { timeout: 15000 })

    await counter.click()
    const list = win.locator('[data-testid="bg-list"]')
    await expect(list).toBeVisible()
    // It opens upward, above the status line.
    const listBox = await list.boundingBox()
    const lineBox = await win.locator('[data-testid="status-line"]').boundingBox()
    expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(lineBox!.y + 1)

    const task = list.locator('[data-testid="bg-task"]')
    await expect(task).toHaveCount(1)
    await expect(task).toContainText('npm run dev')
    await expect(task).toContainText('работает')

    await task.locator('[data-testid="bg-task-toggle"]').click()
    const output = task.locator('[data-testid="bg-output"]')
    await expect(output).toContainText('готово 1')
    // Polled while open: the second piece arrives without another click.
    await expect(output).toContainText('готово 2', { timeout: 5000 })

    await task.locator('[data-testid="bg-stop"]').click()
    await expect(task).toContainText('остановлена')
    await expect(task.locator('[data-testid="bg-stop"]')).toHaveCount(0)
    await expect(counter).toHaveText('Фоновые')
  } finally {
    await close(app, profile)
  }
})

test('законченная задача остаётся в списке с итогом', async () => {
  const { app, profile } = await launch({
    steps: [],
    nextTurn: [
      {
        kind: 'backgroundBash',
        command: 'npm run build',
        chunks: ['собрано\n'],
        pauseMs: 100,
        finish: 'completed'
      },
      {
        kind: 'backgroundBash',
        command: 'npm run lint',
        chunks: [],
        pauseMs: 100,
        finish: 'failed'
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="status-context"]')).toBeVisible({ timeout: 15000 })
    await send(win, 'собери')

    const counter = win.locator('[data-testid="status-bg"]')
    // Both ended: the counter stays, without a number.
    await expect(counter).toHaveText('Фоновые', { timeout: 15000 })
    await counter.click()

    const tasks = win.locator('[data-testid="bg-task"]')
    await expect(tasks).toHaveCount(2)
    // Newest first.
    await expect(tasks.nth(0)).toContainText('npm run lint')
    await expect(tasks.nth(0)).toContainText('ошибка')
    await expect(tasks.nth(1)).toContainText('npm run build')
    await expect(tasks.nth(1)).toContainText('готова')
    await expect(win.locator('[data-testid="bg-stop"]')).toHaveCount(0)

    // An ended task's output is read once, when it is opened.
    await tasks.nth(1).locator('[data-testid="bg-task-toggle"]').click()
    await expect(tasks.nth(1).locator('[data-testid="bg-output"]')).toContainText('собрано')

    // Esc closes the list.
    await win.keyboard.press('Escape')
    await expect(win.locator('[data-testid="bg-list"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('отказ остановить виден в строке задачи, задача работает дальше', async () => {
  const { app, profile } = await launch({
    steps: [],
    stopTaskError: 'задача уже закончилась',
    nextTurn: [{ kind: 'backgroundBash', command: 'npm run dev', finish: null }]
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="status-context"]')).toBeVisible({ timeout: 15000 })
    await send(win, 'запусти')
    await win.locator('[data-testid="status-bg"]').click({ timeout: 15000 })
    const task = win.locator('[data-testid="bg-task"]')
    await task.locator('[data-testid="bg-stop"]').click()
    await expect(task.locator('[data-testid="bg-stop-error"]')).toHaveText(
      'Не удалось остановить: задача уже закончилась'
    )
    await expect(task).toContainText('работает')
    // The button is back for another try.
    await expect(task.locator('[data-testid="bg-stop"]')).toBeEnabled()
  } finally {
    await close(app, profile)
  }
})

test('Esc из поля ввода закрывает список и не прерывает агента', async () => {
  const { app, profile } = await launch({
    steps: [],
    nextTurn: [
      { kind: 'backgroundBash', command: 'npm run dev', finish: null },
      { kind: 'tool', name: 'Read', input: { file_path: 'a.ts' }, pauseMs: 8000 }
    ]
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="status-context"]')).toBeVisible({ timeout: 15000 })
    await send(win, 'запусти')
    const nowLine = win.locator('[data-testid="now-line"]')
    await expect(nowLine).toHaveClass(/is-turn/, { timeout: 15000 })

    await win.locator('[data-testid="status-bg"]').click()
    await expect(win.locator('[data-testid="bg-list"]')).toBeVisible()
    // Focus back in the input without a click (a click outside closes the list by itself).
    await win.locator('[data-testid="composer-input"]').focus()
    await win.keyboard.press('Escape')

    await expect(win.locator('[data-testid="bg-list"]')).toHaveCount(0)
    // The turn goes on: Esc was the list's.
    await expect(nowLine).toHaveClass(/is-turn/)
    // With the list closed, Esc is the agent's again.
    await win.keyboard.press('Escape')
    await expect(win.locator('[data-testid="now-line"].is-turn')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('CLI без чтения вывода — понятная строка вместо пустоты', async () => {
  const { app, profile } = await launch({
    steps: [],
    taskOutputUnavailable: true,
    nextTurn: [{ kind: 'backgroundBash', command: 'npm run dev', chunks: ['x'], pauseMs: 50, finish: null }]
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="status-context"]')).toBeVisible({ timeout: 15000 })
    await send(win, 'запусти')
    await win.locator('[data-testid="status-bg"]').click({ timeout: 15000 })
    await win.locator('[data-testid="bg-task-toggle"]').click()
    await expect(win.locator('[data-testid="bg-output"]')).toHaveText(
      'Вывод недоступен в этой версии Claude Code'
    )
  } finally {
    await close(app, profile)
  }
})
