import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(script: unknown): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-commands-'))
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

/** What the session says it offers — including one that cannot work here. */
const COMMANDS = [
  { name: 'compact', description: 'Сжать контекст', argumentHint: '', builtin: true },
  { name: 'model', description: 'Сменить модель', argumentHint: '<model>', builtin: true },
  { name: 'resume', description: 'Открыть прошлую сессию', argumentHint: '', builtin: true },
  { name: 'моя-команда', description: 'Команда из этого проекта', argumentHint: '' },
  { name: 'remote-control', description: 'Удалённое управление', argumentHint: '' }
]

/** Opens one of the status line's lists and picks the row with this id. */
async function choose(win: Page, testId: string, value: string): Promise<void> {
  await win.locator(`[data-testid="${testId}"]`).click()
  await win.locator(`[data-testid="${testId}-option"][data-id="${value}"]`).click()
}

async function ready(win: Page): Promise<ReturnType<Page['locator']>> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.waitFor({ timeout: 15000 })
  await input.click()
  return input
}

test('/ показывает список прямо над полем, модалки нет', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)

    await input.press('/')

    const menu = win.locator('[data-testid="slash-menu"]')
    await expect(menu).toBeVisible()
    await expect(win.locator('[data-testid="command-palette"]')).toHaveCount(0)
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('/')

    // Right above the input, not floating somewhere over the conversation.
    const list = await menu.boundingBox()
    const field = await win.locator('.composer-row').boundingBox()
    expect(list && field).toBeTruthy()
    expect(list!.y + list!.height).toBeLessThanOrEqual(field!.y)
    expect(field!.y - (list!.y + list!.height)).toBeLessThan(40)

    // The session's own list, every command once, including this project's.
    await expect(menu.locator('[data-testid="slash-item"]')).toHaveCount(6)
    await expect(menu).toContainText('/моя-команда')
    await expect(menu).toContainText('Команда из этого проекта')
    // The argument hint is shown beside the name.
    await expect(
      menu.locator('[data-testid="slash-item"]', { hasText: '/model' })
    ).toContainText('<model>')
  } finally {
    await close(app, profile)
  }
})

test('набор фильтрует, Enter выполняет', async () => {
  const { app, profile } = await launch({
    steps: [],
    init: { commands: COMMANDS },
    nextTurn: [{ kind: 'text', text: 'контекст сжат' }]
  })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)

    await input.pressSequentially('/cmp')
    const items = win.locator('[data-testid="slash-item"]')
    await expect(items.first()).toContainText('/compact')
    await expect(items.first()).toHaveAttribute('aria-selected', 'true')
    await input.press('Enter')

    await expect(win.locator('[data-testid="slash-menu"]')).toHaveCount(0)
    await expect(input).toHaveValue('')
    await expect(win.locator('[data-testid="ribbon-user"]')).toContainText('/compact')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('контекст сжат', {
      timeout: 15000
    })
  } finally {
    await close(app, profile)
  }
})

test('стрелки выбирают строку', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)

    await input.press('/')
    const items = win.locator('[data-testid="slash-item"]')
    await expect(items.nth(0)).toHaveAttribute('aria-selected', 'true')
    await input.press('ArrowDown')
    await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(items.nth(0)).toHaveAttribute('aria-selected', 'false')
    await input.press('ArrowUp')
    await expect(items.nth(0)).toHaveAttribute('aria-selected', 'true')
  } finally {
    await close(app, profile)
  }
})

test('Tab дописывает команду, не отправляя', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)

    await input.pressSequentially('/comp')
    await expect(win.locator('[data-testid="slash-menu"]')).toBeVisible()
    await input.press('Tab')

    await expect(input).toHaveValue('/compact ')
    await expect(input).toBeFocused()
    await expect(win.locator('[data-testid="slash-menu"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('Esc закрывает список, текст остаётся', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)

    await input.pressSequentially('/com')
    await expect(win.locator('[data-testid="slash-menu"]')).toBeVisible()
    await input.press('Escape')

    await expect(win.locator('[data-testid="slash-menu"]')).toHaveCount(0)
    await expect(input).toHaveValue('/com')
    await expect(input).toBeFocused()

    // Typing on brings it back.
    await input.press('p')
    await expect(win.locator('[data-testid="slash-menu"]')).toBeVisible()
  } finally {
    await close(app, profile)
  }
})

test('/model — второй шаг со списком моделей', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)
    const picker = win.locator('[data-testid="status-model"]')
    await expect(picker).toHaveAttribute('data-value', 'claude-opus-5')

    await input.pressSequentially('/model')
    await input.press('Enter')

    const items = win.locator('[data-testid="slash-item"]')
    await expect(win.locator('[data-testid="slash-menu"]')).toBeVisible()
    await expect(items).toHaveCount(2)
    await expect(items.nth(1)).toContainText('Sonnet 5')
    await expect(items.nth(1)).toContainText('быстрее и дешевле')
    // Sending "/model" with no argument would have done nothing at all.
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)

    await input.press('ArrowDown')
    await input.press('Enter')

    await expect(picker).toHaveAttribute('data-value', 'claude-sonnet-5')
    await expect(input).toHaveValue('')
    await expect(win.locator('[data-testid="slash-menu"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('/effort — второй шаг с уровнями выбранной модели', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)
    // Sonnet offers three levels where Opus offers five.
    await choose(win, 'status-model', 'claude-sonnet-5')
    await expect(win.locator('[data-testid="status-model"]')).toHaveAttribute('data-value', 'claude-sonnet-5')
    await input.click()

    await input.pressSequentially('/effort')
    await input.press('Enter')

    const items = win.locator('[data-testid="slash-item"]')
    await expect(items).toHaveCount(3)
    await input.press('ArrowDown')
    await input.press('ArrowDown')
    await input.press('Enter')

    await expect(win.locator('[data-testid="status-effort"]')).toHaveAttribute('data-value', 'high')
    await expect(input).toHaveValue('')
  } finally {
    await close(app, profile)
  }
})

test('/remote-control помечена и не выполняется', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)

    await input.pressSequentially('/remote')
    const item = win.locator('[data-testid="slash-item"]').first()
    await expect(item).toContainText('только в терминале')
    await expect(item).toHaveAttribute('aria-disabled', 'true')

    await input.press('Enter')
    // Playwright treats an aria-disabled row as unclickable; a person can still click it.
    await item.click({ force: true })

    // Still open, nothing sent: the command cannot do anything here.
    await expect(win.locator('[data-testid="slash-menu"]')).toBeVisible()
    await expect(input).toHaveValue('/remote')
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('команда с параметром подставляется в поле, а не отправляется половиной', async () => {
  const { app, profile } = await launch({
    steps: [],
    init: {
      commands: [{ name: 'rename', description: 'Переименовать сессию', argumentHint: '<название>' }]
    }
  })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)

    await input.pressSequentially('/ren')
    await input.press('Enter')

    await expect(input).toHaveValue('/rename ')
    await expect(input).toBeFocused()
    await expect(win.locator('[data-testid="slash-menu"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)

    // And finishing it sends the whole thing.
    await input.pressSequentially('переезд на SDK')
    await input.press('Enter')
    await expect(win.locator('[data-testid="ribbon-user"]')).toContainText('/rename переезд на SDK')
  } finally {
    await close(app, profile)
  }
})

test('слеш посреди текста — не команда', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)

    await input.pressSequentially('путь src/a')
    await expect(input).toHaveValue('путь src/a')
    await expect(win.locator('[data-testid="slash-menu"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('усилие в строке статуса выбирается из уровней, которые поддерживает модель', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })

    const effort = win.locator('[data-testid="status-effort"]')
    await expect(effort).toBeEnabled({ timeout: 15000 })
    await effort.click()
    await expect(win.locator('[data-testid="status-effort-option"]')).toHaveCount(5)
    await win.locator('[data-testid="status-effort-option"][data-id="high"]').click()
    await expect(effort).toHaveAttribute('data-value', 'high')

    // Sonnet offers three levels where Opus offers five.
    await choose(win, 'status-model', 'claude-sonnet-5')
    await expect(win.locator('[data-testid="status-model"]')).toHaveAttribute('data-value', 'claude-sonnet-5')
    await effort.click()
    await expect(win.locator('[data-testid="status-effort-option"]')).toHaveCount(3)
  } finally {
    await close(app, profile)
  }
})

test('/model, пока сессия не прислала моделей, — не тупик и не уходит агенту', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS, models: [] } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)

    await input.pressSequentially('/model')
    await input.press('Enter')

    // One row that says why there is nothing to pick, and it holds Enter.
    const items = win.locator('[data-testid="slash-item"]')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText('Список моделей загружается')
    await expect(items.first()).toHaveAttribute('aria-disabled', 'true')
    await input.press('Enter')
    await expect(input).toHaveValue('/model ')
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)

    // Closed with Esc, «/model » is still never sent: Enter brings the list back.
    await input.press('Escape')
    await expect(win.locator('[data-testid="slash-menu"]')).toHaveCount(0)
    await input.press('Enter')
    await expect(win.locator('[data-testid="slash-menu"]')).toBeVisible()
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('поле ввода говорит экранному диктору, какая строка выбрана', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)
    await expect(input).toHaveAttribute('aria-expanded', 'false')

    await input.press('/')
    await input.press('ArrowDown')
    const second = win.locator('[data-testid="slash-item"]').nth(1)
    const id = await second.getAttribute('id')
    expect(id).toBeTruthy()
    await expect(input).toHaveAttribute('aria-activedescendant', id!)
    await expect(input).toHaveAttribute('aria-expanded', 'true')
    await expect(input).toHaveAttribute('aria-autocomplete', 'list')
    const listId = await win.locator('[data-testid="slash-menu"] [role="listbox"]').getAttribute('id')
    await expect(input).toHaveAttribute('aria-controls', listId!)
  } finally {
    await close(app, profile)
  }
})

test('Shift+Enter при открытом списке переносит строку', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = await ready(win)
    await input.pressSequentially('/com')
    await input.press('Shift+Enter')
    await expect(input).toHaveValue('/com\n')
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})
