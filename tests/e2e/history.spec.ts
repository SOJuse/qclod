import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DAY = 24 * 60 * 60 * 1000

const HISTORY = {
  sessions: [
    {
      sessionId: 'сессия-1',
      summary: 'Починка вставки файлов',
      lastModified: Date.now() - 2 * DAY,
      firstPrompt: 'вставка файлов не работает'
    },
    {
      sessionId: 'сессия-2',
      summary: 'Переезд на SDK',
      lastModified: Date.now() - 5 * DAY,
      firstPrompt: 'давай перепишем ядро'
    }
  ],
  messages: {
    'сессия-1': [
      { type: 'user', message: { role: 'user', content: 'вставка файлов не работает' } },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'нашёл: обработчик не читает clipboardData.files' }]
        }
      }
    ]
  }
}

async function launch(history: unknown): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-history-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({ steps: [] }),
      QCLOD_FAKE_HISTORY: JSON.stringify(history)
    } as Record<string, string>
  })
  return { app, profile }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

test('экран истории показывает сессии текущей папки с датой и первой репликой', async () => {
  const { app, profile } = await launch(HISTORY)
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })

    await win.keyboard.press('Control+H')
    const screen = win.locator('[data-testid="history-screen"]')
    await expect(screen).toBeVisible()

    const items = screen.locator('[data-testid="history-item"]')
    await expect(items).toHaveCount(2)
    await expect(items.first()).toContainText('Починка вставки файлов')
    await expect(items.first()).toContainText('вставка файлов не работает')
    // A date a person can read, not a timestamp.
    await expect(items.first()).not.toContainText('17')
  } finally {
    await close(app, profile)
  }
})

test('поиск по истории фильтрует список', async () => {
  const { app, profile } = await launch(HISTORY)
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    await win.keyboard.press('Control+H')

    await win.locator('[data-testid="history-query"]').fill('sdk')
    const items = win.locator('[data-testid="history-item"]')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText('Переезд на SDK')

    // Searching the first message too, not only the title.
    await win.locator('[data-testid="history-query"]').fill('перепишем')
    await expect(items).toHaveCount(1)

    await win.locator('[data-testid="history-query"]').fill('щщщ')
    await expect(win.locator('[data-testid="history-empty"]')).toContainText('Ничего не нашлось')
  } finally {
    await close(app, profile)
  }
})

test('у папки без сессий — понятная пустота, а не пустой список', async () => {
  const { app, profile } = await launch({ sessions: [] })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    await win.keyboard.press('Control+H')

    await expect(win.locator('[data-testid="history-empty"]')).toContainText(
      'ещё не было разговоров'
    )
    await expect(win.locator('[data-testid="history-item"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('открытие сессии поднимает её в новой вкладке с восстановленной лентой', async () => {
  const { app, profile } = await launch(HISTORY)
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(1)

    await win.keyboard.press('Control+H')
    await win.locator('[data-testid="history-item"]').first().click()

    await expect(win.locator('[data-testid="history-screen"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })

    // The conversation itself is back, both sides of it.
    const ribbon = win.locator('[data-testid="ribbon"]')
    await expect(ribbon).toContainText('вставка файлов не работает', { timeout: 15000 })
    await expect(ribbon).toContainText('clipboardData.files')
  } finally {
    await close(app, profile)
  }
})
