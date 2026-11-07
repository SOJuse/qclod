import { test, expect, _electron as electron } from '@playwright/test'

test('вывод подставного агента появляется в терминале', async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()

  const terminal = win.locator('[data-testid="terminal"]')
  await expect(terminal).toBeVisible()
  await expect(terminal).toContainText('fake-agent ready', { timeout: 20000 })

  await app.close()
})

test('набранное в терминале уходит агенту и возвращается ответом', async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()

  const terminal = win.locator('[data-testid="terminal"]')
  await expect(terminal).toContainText('fake-agent ready', { timeout: 20000 })

  await terminal.click()
  await win.keyboard.type('привет')
  await win.keyboard.press('Enter')

  await expect(terminal).toContainText('[submit 1]', { timeout: 15000 })

  await app.close()
})
