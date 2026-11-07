import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
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

test('/ открывает палитру со списком из SDK, а не захардкоженным', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.press('/')

    const palette = win.locator('[data-testid="command-palette"]')
    await expect(palette).toBeVisible()
    await expect(palette.locator('[data-testid="palette-item"]')).toHaveCount(COMMANDS.length)
    // A command this project defines, not one of five we invented.
    await expect(palette).toContainText('моя-команда')
    await expect(palette).toContainText('Команда из этого проекта')
  } finally {
    await close(app, profile)
  }
})

test('выбор команды отправляет её агенту', async () => {
  const { app, profile } = await launch({
    steps: [],
    init: { commands: COMMANDS },
    nextTurn: [{ kind: 'text', text: 'контекст сжат' }]
  })
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.press('/')
    await win.locator('[data-testid="palette-query"]').fill('cmp')
    await win.locator('[data-testid="palette-query"]').press('Enter')

    await expect(win.locator('[data-testid="command-palette"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="ribbon-user"]')).toContainText('/compact')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('контекст сжат', {
      timeout: 15000
    })
  } finally {
    await close(app, profile)
  }
})

test('недоступная команда помечена и не выбирается', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.press('/')
    await win.locator('[data-testid="palette-query"]').fill('remote')

    const item = win.locator('[data-testid="palette-item"]').first()
    await expect(item).toContainText('только в терминале')
    await item.click()

    // Still open, nothing sent: the command cannot do anything here.
    await expect(win.locator('[data-testid="command-palette"]')).toBeVisible()
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('Esc закрывает палитру и возвращает текст', async () => {
  const { app, profile } = await launch({ steps: [], init: { commands: COMMANDS } })
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.press('/')
    await expect(win.locator('[data-testid="command-palette"]')).toBeVisible()

    await win.locator('[data-testid="palette-query"]').press('Escape')

    await expect(win.locator('[data-testid="command-palette"]')).toHaveCount(0)
    await expect(input).toBeFocused()
    await input.type('обычный текст')
    await expect(input).toHaveValue('обычный текст')
  } finally {
    await close(app, profile)
  }
})

test('/model открывает выбор модели в панели, а не уходит пустым', async () => {
  const { app, profile } = await launch({
    steps: [],
    init: {
      commands: [
        { name: 'model', description: 'Сменить модель', argumentHint: '<model>', builtin: true }
      ]
    }
  })
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.press('/')
    await win.locator('[data-testid="palette-item"]').first().click()

    const picker = win.locator('[data-testid="panel-model"]')
    await expect(picker).toBeFocused()
    // Sending "/model" with no argument would have done nothing at all.
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)

    // The real list, from the session.
    await expect(picker.locator('option')).toHaveCount(2)
    await picker.selectOption('claude-sonnet-5')
    await expect(picker).toHaveValue('claude-sonnet-5')
  } finally {
    await close(app, profile)
  }
})

test('усилие выбирается из уровней, которые поддерживает модель', async () => {
  const { app, profile } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })

    const effort = win.locator('[data-testid="panel-effort"]')
    await expect(effort).toBeVisible()
    await effort.selectOption('high')
    await expect(effort).toHaveValue('high')

    // Sonnet offers three levels where Opus offers five.
    await win.locator('[data-testid="panel-model"]').selectOption('claude-sonnet-5')
    await expect(effort.locator('option')).toHaveCount(3)
  } finally {
    await close(app, profile)
  }
})

test('команда с параметром подставляется в поле, а не отправляется половиной', async () => {
  const { app, profile } = await launch({
    steps: [],
    init: {
      commands: [
        { name: 'rename', description: 'Переименовать сессию', argumentHint: '<название>' }
      ]
    }
  })
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.press('/')
    await win.locator('[data-testid="palette-item"]').first().click()

    await expect(input).toHaveValue('/rename ')
    await expect(input).toBeFocused()
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)

    // And finishing it sends the whole thing.
    await input.type('переезд на SDK')
    await input.press('Enter')
    await expect(win.locator('[data-testid="ribbon-user"]')).toContainText('/rename переезд на SDK')
  } finally {
    await close(app, profile)
  }
})
