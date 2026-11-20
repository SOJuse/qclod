import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(
  script: unknown,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; profile: string; folder: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-keyboard-'))
  const folder = mkdtempSync(join(tmpdir(), 'qclod-keyboard-cwd-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_PICK_FOLDER: folder,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(script),
      ...extraEnv
    } as Record<string, string>
  })
  return { app, profile, folder }
}

async function close(app: ElectronApplication, ...dirs: string[]): Promise<void> {
  await app.close().catch(() => undefined)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

async function ready(win: Page): Promise<void> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.waitFor({ timeout: 15000 })
  await input.click()
}

const tabs = (win: Page) => win.locator('[data-testid="tab"]')
const active = (win: Page) => win.locator('[data-testid="tab"].is-active')

test('Ctrl+T открывает вкладку, Ctrl+1/Ctrl+2 переключают, Ctrl+Tab по кругу', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await expect(tabs(win)).toHaveCount(1)

    await win.keyboard.press('Control+t')
    await expect(tabs(win)).toHaveCount(2)
    await expect(active(win)).toHaveCount(1)
    await expect(tabs(win).nth(1)).toHaveClass(/is-active/)

    await win.keyboard.press('Control+1')
    await expect(tabs(win).nth(0)).toHaveClass(/is-active/)
    await win.keyboard.press('Control+2')
    await expect(tabs(win).nth(1)).toHaveClass(/is-active/)

    // Round the ring: forward from the last wraps to the first, back goes the other way.
    await win.keyboard.press('Control+Tab')
    await expect(tabs(win).nth(0)).toHaveClass(/is-active/)
    await win.keyboard.press('Control+Shift+Tab')
    await expect(tabs(win).nth(1)).toHaveClass(/is-active/)

    // Ctrl+9 is the last tab; Ctrl+5 with only two tabs does nothing.
    await win.keyboard.press('Control+1')
    await win.keyboard.press('Control+9')
    await expect(tabs(win).nth(1)).toHaveClass(/is-active/)
    await win.keyboard.press('Control+5')
    await expect(tabs(win).nth(1)).toHaveClass(/is-active/)
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+W закрывает свободную вкладку сразу', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await win.keyboard.press('Control+t')
    await expect(tabs(win)).toHaveCount(2)

    await win.keyboard.press('Control+w')
    await expect(tabs(win)).toHaveCount(1)
    await expect(win.locator('[data-testid="close-guard"]')).toHaveCount(0)
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+W на работающей вкладке закрывает только со второго раза', async () => {
  const { app, profile, folder } = await launch({
    steps: [{ kind: 'text', text: 'готов' }],
    nextTurn: [{ kind: 'textStream', pieces: ['думаю', ' дальше', ' ещё'], pauseMs: 400 }]
  })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await win.keyboard.press('Control+t')
    await expect(tabs(win)).toHaveCount(2)

    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await input.fill('поехали')
    await input.press('Enter')
    await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 15000 })

    await win.keyboard.press('Control+w')
    const guard = win.locator('[data-testid="close-guard"]')
    await expect(guard).toContainText('Ctrl+W ещё раз закроет чат')
    await expect(tabs(win)).toHaveCount(2)

    await win.keyboard.press('Control+w')
    await expect(tabs(win)).toHaveCount(1)
    await expect(guard).toHaveCount(0)
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+B прячет боковую панель, кнопка в заголовке возвращает её', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    const sidebar = win.locator('[data-testid="sidebar"]')
    const toggle = win.locator('[data-testid="sidebar-toggle"]')
    await expect(sidebar).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-label', 'Скрыть боковую панель')
    expect(await toggle.getAttribute('title')).toContain('Ctrl+B')

    await win.keyboard.press('Control+b')
    await expect(sidebar).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-label', 'Показать боковую панель')

    await toggle.click()
    await expect(sidebar).toBeVisible()
    await expect(tabs(win)).toHaveCount(1)
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+K открывает поиск по всему; «настр» + Enter открывает настройки', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)

    await win.keyboard.press('Control+k')
    const palette = win.locator('[data-testid="action-palette"]')
    await expect(palette).toBeVisible()
    const query = win.locator('[data-testid="action-query"]')
    await expect(query).toBeFocused()
    await expect(query).toHaveAttribute('placeholder', 'Чат, проект, файл или команда')
    // Task 7: not the 17 actions any more — the open chats, then the first eight commands, each under its heading.
    await expect(palette.locator('[data-testid="action-item"][data-section="chats"]')).toHaveCount(1)
    await expect(palette.locator('[data-testid="action-item"][data-section="commands"]')).toHaveCount(8)
    await expect(palette.locator('[data-testid="palette-section"]').first()).toHaveText('Чаты')
    await expect(palette.locator('[data-testid="palette-section"]').last()).toHaveText('Команды')

    // «>» keeps it to the commands.
    await query.fill('>')
    await expect(palette.locator('[data-testid="action-item"]:not([data-section="commands"])')).toHaveCount(0)
    await expect(palette.locator('[data-testid="action-item"]')).toHaveCount(8)
    await query.fill('')

    // Esc closes it and the cursor goes back to the input.
    await win.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
    await expect(win.locator('[data-testid="composer-input"]')).toBeFocused()

    await win.keyboard.press('Control+k')
    await win.locator('[data-testid="action-query"]').pressSequentially('настр')
    await expect(win.locator('[data-testid="action-item"]').first()).toContainText('Настройки')
    await win.keyboard.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect(win.locator('[data-testid="settings"]')).toBeVisible()
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+K на русской раскладке (код клавиши, не буква) тоже открывает палитру', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await win.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'л', code: 'KeyK', ctrlKey: true, cancelable: true })
      )
    )
    await expect(win.locator('[data-testid="action-palette"]')).toBeVisible()
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+W при открытой палитре не закрывает окно', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await win.keyboard.press('Control+k')
    await expect(win.locator('[data-testid="action-palette"]')).toBeVisible()
    await win.keyboard.press('Control+w')
    await win.waitForTimeout(500)
    expect(win.isClosed()).toBe(false)
    expect(app.windows().length).toBe(1)
    await expect(win.locator('[data-testid="action-palette"]')).toBeVisible()
    await expect(tabs(win)).toHaveCount(1)
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+K закрывает палитру и возвращает курсор в поле', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await win.keyboard.press('Control+k')
    await expect(win.locator('[data-testid="action-palette"]')).toBeVisible()
    await win.keyboard.press('Control+k')
    await expect(win.locator('[data-testid="action-palette"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="composer-input"]')).toBeFocused()
  } finally {
    await close(app, profile, folder)
  }
})

test('копирование, вставка и отмена в поле работают', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    const input = win.locator('[data-testid="composer-input"]')
    await input.pressSequentially('привет')
    await win.keyboard.press('Control+a')
    await win.keyboard.press('Control+c')
    await win.keyboard.press('End')
    await win.keyboard.press('Control+v')
    await expect(input).toHaveValue('приветпривет')
    await win.keyboard.press('Control+z')
    await expect(input).not.toHaveValue('приветпривет')
  } finally {
    await close(app, profile, folder)
  }
})

test('у каждой видимой кнопки есть подсказка, у кнопок с клавишей — с клавишей', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    const buttons = await win.locator('button:visible').all()
    expect(buttons.length).toBeGreaterThan(5)
    for (const b of buttons) expect((await b.getAttribute('title'))?.trim()).toBeTruthy()
    expect(await win.locator('[data-testid="tab-new"]').getAttribute('title')).toContain('Ctrl+T')
    expect(await win.locator('[data-testid="open-settings"]').getAttribute('title')).toContain('Ctrl+,')
    expect(await win.locator('[data-testid="panel-open"], [data-testid="panel-close"]').first().getAttribute('title')).toContain('Ctrl+\\')
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+= / Ctrl+- / Ctrl+0 меняют масштаб окна, строки есть в палитре', async () => {
  const { app, profile, folder } = await launch({ steps: [] })
  try {
    const win = await app.firstWindow()
    await ready(win)
    const zoom = (): Promise<number> =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomLevel())
    expect(await zoom()).toBe(0)
    await win.keyboard.press('Control+=')
    await expect.poll(zoom).toBe(0.5)
    await win.keyboard.press('Control+-')
    await win.keyboard.press('Control+-')
    await expect.poll(zoom).toBe(-0.5)
    await win.keyboard.press('Control+0')
    await expect.poll(zoom).toBe(0)

    await win.keyboard.press('Control+k')
    await win.locator('[data-testid="action-query"]').fill('круп')
    await expect(win.locator('[data-testid="action-item"]').first()).toContainText('Крупнее')
    await win.keyboard.press('Enter')
    await expect.poll(zoom).toBe(0.5)
  } finally {
    await close(app, profile, folder)
  }
})

test('Ctrl+R: черновик, вложение и вторая панель возвращаются после перезагрузки окна', async () => {
  const picked = join(mkdtempSync(join(tmpdir(), 'qclod-reload-')), 'мой файл.ts')
  writeFileSync(picked, 'export const x = 1\n', 'utf8')
  const { app, profile, folder } = await launch({ steps: [] }, { QCLOD_PICK_FILES: picked })
  try {
    const win = await app.firstWindow()
    await ready(win)
    await win.keyboard.press('Control+t')
    await expect(tabs(win)).toHaveCount(2)
    await win.keyboard.press('Control+Shift+Enter')
    await expect(win.locator('[data-testid="chat-pane"]')).toHaveCount(2)

    const input = win.locator('[data-testid="composer-input"]').first()
    await input.click()
    await input.pressSequentially('недописанная мысль')
    await win.locator('[data-testid="composer-clip"]').first().click()
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(1)

    await win.keyboard.press('Control+r')
    await win.waitForLoadState('domcontentloaded')

    await expect(win.locator('[data-testid="chat-pane"]')).toHaveCount(2, { timeout: 15000 })
    await expect(win.locator('[data-testid="composer-input"]').first()).toHaveValue('недописанная мысль')
    await expect(win.locator('[data-testid="composer-chip"]')).toContainText('мой файл.ts')
  } finally {
    await close(app, profile, folder)
  }
})
