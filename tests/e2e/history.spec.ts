import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
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

/**
 * The launch environment, never carrying QCLOD_ALLOW_REAL: a test that runs
 * without the fixture may then only fail, never start the real agent.
 */
function withoutRealAgent(env: Record<string, string | undefined>): Record<string, string> {
  const out = { ...env }
  delete out['QCLOD_ALLOW_REAL']
  return out as Record<string, string>
}

async function launch(
  history: unknown,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-history-'))
  const app = await electron.launch({
    args: ['.'],
    env: withoutRealAgent({
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
    })
  })
  return { app, profile }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

/** The project the first chat works in: the only one at start. */
const firstProject = (win: Page) => win.locator('[data-testid="project"]').first()
const sessions = (win: Page) => win.locator('[data-testid="sidebar-session"]')
const tabs = (win: Page) => win.locator('[data-testid="tab"]')

test('прошлые сессии видны в боковой панели под проектом, с короткой датой', async () => {
  const { app, profile } = await launch(HISTORY)
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })

    await expect(win.locator('[data-testid="project"]')).toHaveCount(1)
    await expect(win.locator('[data-testid="sidebar-past-head"]')).toHaveText('Прошлые')
    await expect(sessions(win)).toHaveCount(2)
    // Newest first, a title and a date a person can read, not a timestamp.
    await expect(sessions(win).first()).toContainText('Починка вставки файлов')
    await expect(sessions(win).nth(1)).toContainText('Переезд на SDK')
    await expect(sessions(win).first().locator('.past-when')).not.toHaveText(/\d{5,}/)
    await expect(sessions(win).first().locator('.past-when')).not.toHaveText('')
  } finally {
    await close(app, profile)
  }
})

test('клик по прошлой сессии открывает чат с её лентой; открытая в «Прошлые» не попадает, закрытая — возвращается', async () => {
  const { app, profile } = await launch(HISTORY)
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    await expect(tabs(win)).toHaveCount(1)
    await expect(sessions(win)).toHaveCount(2)

    await sessions(win).first().click()
    await expect(tabs(win)).toHaveCount(2, { timeout: 15000 })
    const opened = win.locator('[data-testid="tab"].is-active')
    await expect(opened).toContainText('Починка вставки файлов')

    // The conversation itself is back, both sides of it.
    const ribbon = win.locator('[data-testid="ribbon"]')
    await expect(ribbon).toContainText('вставка файлов не работает', { timeout: 15000 })
    await expect(ribbon).toContainText('clipboardData.files')

    // An open conversation is a chat, not a past one.
    await expect(sessions(win)).toHaveCount(1)
    await expect(sessions(win).first()).toContainText('Переезд на SDK')

    // Closed, it is a past conversation again.
    await opened.locator('.tab-close').click()
    await expect(tabs(win)).toHaveCount(1)
    await expect(sessions(win)).toHaveCount(2, { timeout: 15000 })
    await expect(sessions(win).first()).toContainText('Починка вставки файлов')
  } finally {
    await close(app, profile)
  }
})

test('свёрнутый проект прячет чаты и прошлое; Ctrl+H находит его прошлые в палитре', async () => {
  const { app, profile } = await launch(HISTORY)
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    const toggle = firstProject(win).locator('[data-testid="project-toggle"]')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(tabs(win)).toHaveCount(0)
    await expect(sessions(win)).toHaveCount(0)

    // Task 7: Ctrl+H is the palette kept to the past conversations, not a fold.
    await win.keyboard.press('Control+H')
    const palette = win.locator('[data-testid="action-palette"]')
    await expect(palette.locator('[data-testid="palette-scope"]')).toHaveText('Прошлые разговоры')
    await expect(palette.locator('[data-testid="action-item"][data-section="history"]')).toHaveCount(2)
    await expect(palette.locator('[data-testid="action-item"]:not([data-section="history"])')).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await close(app, profile)
  }
})

test('Ctrl+H: поиск по прошлым — по названию и первому сообщению, Enter открывает, Backspace снимает раздел', async () => {
  const { app, profile } = await launch(HISTORY)
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    await expect(sessions(win)).toHaveCount(2)
    const palette = win.locator('[data-testid="action-palette"]')
    const query = palette.locator('[data-testid="action-query"]')
    const past = palette.locator('[data-testid="action-item"][data-section="history"]')

    await win.keyboard.press('Control+H')
    await expect(query).toBeFocused()
    await query.fill('sdk')
    await expect(past).toHaveCount(1)
    await expect(past.first()).toContainText('Переезд на SDK')
    // The first message counts too, not only the title.
    await query.fill('перепишем')
    await expect(past).toHaveCount(1)
    await expect(past.first()).toContainText('Переезд на SDK')

    await query.fill('щщщ')
    await expect(palette.locator('[data-state="empty"]')).toContainText('Ничего не нашлось')
    await expect(palette.locator('[data-testid="action-item"]')).toHaveCount(0)

    // Backspace in the empty field takes the chip off: the search is over everything again.
    await query.fill('')
    await query.press('Backspace')
    await expect(palette.locator('[data-testid="palette-scope"]')).toHaveCount(0)
    await expect(palette.locator('[data-testid="action-item"][data-section="commands"]')).toHaveCount(8)

    // Ctrl+H on the open palette keeps it to the past ones again; Enter opens the chosen one in its own chat.
    await win.keyboard.press('Control+H')
    await expect(palette.locator('[data-testid="palette-scope"]')).toHaveText('Прошлые разговоры')
    await query.fill('sdk')
    await expect(past).toHaveCount(1)
    await query.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect(tabs(win)).toHaveCount(2, { timeout: 15000 })
    await expect(win.locator('[data-testid="tab"].is-active')).toContainText('Переезд на SDK')
  } finally {
    await close(app, profile)
  }
})

test('у папки без сессий в боковой панели нет ни подзаголовка «Прошлые», ни строк', async () => {
  const { app, profile } = await launch({ sessions: [] })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    await expect(tabs(win)).toHaveCount(1)
    // The read is done once the empty tab has drawn its tips.
    await expect(win.locator('[data-testid="empty-tips"]')).toBeVisible()
    await expect(win.locator('[data-testid="sidebar-past-head"]')).toHaveCount(0)
    await expect(sessions(win)).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('Ctrl+H, пока история читается или не прочиталась, говорит это, а не «Ничего не нашлось»; «Повторить» читает снова', async () => {
  const { app, profile } = await launch(HISTORY, {
    QCLOD_FAKE_SLOW: '{"projects:history":1500}',
    QCLOD_FAKE_FAIL: '{"projects:history":"нет доступа"}',
    QCLOD_FAKE_FAIL_TIMES: '{"projects:history":1}'
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    const palette = win.locator('[data-testid="action-palette"]')

    await win.keyboard.press('Control+H')
    await expect(palette.locator('[data-state="loading"]')).toContainText('Загружаю…')
    await expect(palette.locator('[data-state="empty"]')).toHaveCount(0)

    const err = palette.locator('[data-state="error"]')
    await expect(err).toContainText('Не удалось прочитать историю', { timeout: 10000 })
    await expect(err).toContainText('нет доступа')
    await err.getByRole('button', { name: 'Повторить' }).click()
    await expect(palette.locator('[data-testid="action-item"][data-section="history"]')).toHaveCount(2, { timeout: 10000 })
    await expect(err).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('/resume из списка команд открывает палитру с прошлыми, а не уходит агенту', async () => {
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

    // Task 7: the palette kept to the past conversations, as Ctrl+H.
    const palette = win.locator('[data-testid="action-palette"]')
    await expect(palette.locator('[data-testid="palette-scope"]')).toHaveText('Прошлые разговоры')
    await expect(palette.locator('[data-testid="action-item"][data-section="history"]')).toHaveCount(2)
    await expect(input).toHaveValue('')
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
    await sessions(win).first().click()
    await expect(tabs(win)).toHaveCount(2, { timeout: 15000 })

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
    // Without the fixture a test build refuses to start the real agent at all,
    // so the tab says that instead of showing the empty tab.
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('QCLOD_FAKE_SDK', { timeout: 15000 })
    await expect(win.locator('body')).not.toContainText('Почему падает вставка')
    await expect(win.locator('body')).not.toContainText('найди, где падает вставка')
  } finally {
    await close(app, profile)
    rmSync(configDir, { recursive: true, force: true })
  }
})
