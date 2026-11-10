import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resumedSession, writeTranscript } from '../fixtures/transcript.mjs'

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

async function launch(
  history: unknown,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-history-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({
        steps: [],
        init: {
          commands: [
            { name: 'resume', description: 'Resume a conversation', argumentHint: '', builtin: true },
            { name: 'compact', description: 'Сжать контекст', argumentHint: '', builtin: true }
          ]
        }
      }),
      QCLOD_FAKE_HISTORY: JSON.stringify(history),
      ...extraEnv
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

test('кнопка в заголовке открывает историю', async () => {
  // A hotkey nobody told you about is not a feature.
  const { app, profile } = await launch(HISTORY)
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })

    await win.locator('[data-testid="open-history"]').click()

    await expect(win.locator('[data-testid="history-screen"]')).toBeVisible()
    await expect(win.locator('[data-testid="history-item"]')).toHaveCount(2)
  } finally {
    await close(app, profile)
  }
})

test('/resume из списка команд открывает историю, а не уходит агенту', async () => {
  const { app, profile } = await launch(HISTORY)
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.pressSequentially('/resume')

    const item = win.locator('[data-testid="slash-item"]').first()
    await expect(item).toContainText('Открыть прошлый разговор')
    await input.press('Enter')

    await expect(win.locator('[data-testid="history-screen"]')).toBeVisible()
    // Forwarding it would have shown "/resume" in the ribbon and done nothing.
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('открытая из истории сессия показывает то, что было до сжатия', async () => {
  // The session lives only on disk, the way the CLI leaves it: the fake
  // history lists it but has no messages for it, so the ribbon can only come
  // from reading the JSONL under CLAUDE_CONFIG_DIR.
  const configDir = mkdtempSync(join(tmpdir(), 'qclod-config-'))
  const sessionId = '0f0e0d0c-0b0a-4908-8706-050403020100'
  const session = resumedSession(sessionId, process.cwd())
  writeTranscript(configDir, process.cwd(), sessionId, session.lines, session.subagents)

  const { app, profile } = await launch(
    {
      sessions: [
        { sessionId, summary: 'Почему падает вставка', lastModified: Date.now() - DAY, firstPrompt: 'найди, где падает вставка' }
      ]
    },
    { CLAUDE_CONFIG_DIR: configDir }
  )
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    await win.keyboard.press('Control+H')
    await win.locator('[data-testid="history-item"]').first().click()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })

    const ribbon = win.locator('[data-testid="ribbon"]').last()
    // Before the compaction: the first question and the answer to it.
    await expect(ribbon.locator('[data-testid="ribbon-user"]').first()).toContainText('найди, где падает вставка', {
      timeout: 15000
    })
    await expect(ribbon).toContainText('смотрю')

    // The compaction is a divider whose summary opens on demand, not a bubble.
    const divider = ribbon.locator('[data-testid="ribbon-compaction"]')
    await expect(divider).toHaveCount(1)
    await expect(divider).toContainText('Что было до сжатия')
    const bubbles = ribbon.locator('[data-testid="ribbon-user"]')
    await expect(bubbles).toHaveCount(3)
    await expect(bubbles.nth(1)).toContainText('теперь проверь тесты')
    // Typed while the agent was busy: still the person's own words, once.
    await expect(bubbles.nth(2)).toContainText('и ещё глянь логи')

    // All four subagents, each with an honest state.
    const heads = ribbon.locator('[data-testid="subagent-head"]')
    await expect(heads).toHaveCount(4)
    await expect(heads.nth(0)).toContainText('Обзор вставки')
    await expect(heads.nth(3)).toContainText('Долгий обзор')
    await expect(ribbon.locator('[data-testid="ribbon-subagent"]').nth(3)).toContainText('не закончил')
  } finally {
    await close(app, profile)
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('пустая вкладка показывает папку, прошлые разговоры и подсказки', async () => {
  const { app, profile } = await launch(HISTORY)
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })

    const empty = win.locator('[data-testid="empty-tab"]')
    await expect(empty).toBeVisible()
    await expect(empty.locator('[data-testid="empty-recent"]')).toHaveCount(2)
    await expect(empty).toContainText('Починка вставки файлов')
    await expect(empty.locator('[data-testid="empty-tips"]')).toContainText('Ctrl+K')
    await expect(empty.locator('[data-testid="empty-tips"]')).toContainText('Shift+Tab')

    await empty.locator('[data-testid="empty-recent"]').first().click()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('вставка файлов не работает', {
      timeout: 15000
    })
    // A conversation with something in it has no welcome.
    await expect(win.locator('[data-testid="empty-tab"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('в папке без разговоров пустая вкладка не рисует пустую строку про них', async () => {
  const { app, profile } = await launch({ sessions: [] })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    await expect(win.locator('[data-testid="empty-tips"]')).toBeVisible()
    await expect(win.locator('[data-testid="empty-recent"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="empty-recent-list"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('с поддельным SDK или без него пустая вкладка не читает настоящие сессии из ~/.claude', async () => {
  // A decoy in the config folder the real session store would read: it must
  // never show up while the test seam is on, even without QCLOD_FAKE_SDK.
  const configDir = mkdtempSync(join(tmpdir(), 'qclod-config-'))
  const decoy = '0a0b0c0d-0e0f-4a0b-8c0d-0e0f0a0b0c0d'
  const session = resumedSession(decoy, process.cwd())
  writeTranscript(configDir, process.cwd(), decoy, session.lines, session.subagents)

  const { app, profile } = await launch(HISTORY, { QCLOD_FAKE_SDK: '', CLAUDE_CONFIG_DIR: configDir })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    await expect(win.locator('[data-testid="empty-recent"]')).toHaveCount(2)
    await expect(win.locator('[data-testid="empty-tab"]')).not.toContainText('Почему падает вставка')
    await expect(win.locator('[data-testid="empty-tab"]')).not.toContainText('найди, где падает вставка')
  } finally {
    await close(app, profile)
    rmSync(configDir, { recursive: true, force: true })
  }
})
