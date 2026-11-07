import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication
let win: Page

test.beforeEach(async () => {
  app = await electron.launch({ args: ['.'] })
  win = await app.firstWindow()
  await expect(win.locator('[data-testid="terminal"]')).toContainText('fake-agent ready', {
    timeout: 20000
  })
  await win.locator('[data-testid="composer-input"]').click()
})

test.afterEach(async () => {
  await app.close()
})

test('Enter отправляет текст и агент отвечает эхом', async () => {
  await win.keyboard.type('привет агент')
  await win.keyboard.press('Enter')

  await expect(win.locator('[data-testid="terminal"]')).toContainText('[submit 1]', {
    timeout: 15000
  })
  await expect(win.locator('[data-testid="terminal"]')).toContainText('привет агент')
  await expect(win.locator('[data-testid="composer-input"]')).toHaveValue('')
})

test('Shift+Enter добавляет строку, а не отправляет', async () => {
  await win.keyboard.type('первая')
  await win.keyboard.press('Shift+Enter')
  await win.keyboard.type('вторая')

  await expect(win.locator('[data-testid="composer-input"]')).toHaveValue('первая\nвторая')
  await expect(win.locator('[data-testid="terminal"]')).not.toContainText('[submit 1]')
})

test('многострочная вставка приходит агенту одним вводом', async () => {
  await win.locator('[data-testid="composer-input"]').evaluate((el) => {
    const data = new DataTransfer()
    data.setData('text/plain', 'line one\nline two\nline three')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  })

  await expect(win.locator('[data-testid="composer-input"]')).toHaveValue(
    'line one\nline two\nline three'
  )
  await win.keyboard.press('Enter')

  const terminal = win.locator('[data-testid="terminal"]')
  await expect(terminal).toContainText('[submit 1]', { timeout: 15000 })
  await expect(terminal).not.toContainText('[submit 2]')
})

test('набор / показывает индикатор проброса и меню агента', async () => {
  await win.keyboard.type('/menu')
  await expect(win.locator('[data-testid="passthrough-indicator"]')).toBeVisible()

  await win.keyboard.press('Enter')
  await expect(win.locator('[data-testid="terminal"]')).toContainText('menu-open', {
    timeout: 15000
  })
  await expect(win.locator('[data-testid="passthrough-indicator"]')).toBeHidden()
})

test('Ctrl+Backquote переключает подсветку фокуса на терминал и обратно', async () => {
  const composer = win.locator('[data-testid="composer"]')
  const terminal = win.locator('[data-testid="terminal"]')

  await expect(composer).toHaveClass(/is-focused/)
  await win.keyboard.press('Control+`')
  await expect(terminal).toHaveClass(/is-focused/)
  await expect(composer).not.toHaveClass(/is-focused/)

  await win.keyboard.press('Control+`')
  await expect(composer).toHaveClass(/is-focused/)
})

test('черновик переживает переключение фокуса', async () => {
  await win.keyboard.type('недописанная мысль')
  await win.keyboard.press('Control+`')
  await expect(win.locator('[data-testid="terminal"]')).toHaveClass(/is-focused/)
  await win.keyboard.press('Control+`')

  await expect(win.locator('[data-testid="composer-input"]')).toHaveValue('недописанная мысль')
})

test('стрелка вверх при пустом поле достаёт отправленное', async () => {
  await win.keyboard.type('первый запрос')
  await win.keyboard.press('Enter')
  await expect(win.locator('[data-testid="terminal"]')).toContainText('[submit 1]', {
    timeout: 15000
  })

  await win.keyboard.press('ArrowUp')
  await expect(win.locator('[data-testid="composer-input"]')).toHaveValue('первый запрос')
})

test('меню агента само забирает фокус в терминал', async () => {
  await win.keyboard.type('/menu')
  await win.keyboard.press('Enter')

  await expect(win.locator('[data-testid="terminal"]')).toContainText('menu-open', {
    timeout: 15000
  })
  // Auto-focus is convenience, but when it works the arrows must land in the menu.
  await expect(win.locator('[data-testid="terminal"]')).toHaveClass(/is-focused/)

  await win.keyboard.press('ArrowDown')
  await expect(win.locator('[data-testid="terminal"]')).toContainText('❯ option-2')
})
