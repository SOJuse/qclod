import { test, expect } from '@playwright/test'
import { launchQclod } from './helpers/launch'

/** The terminal of a local chat: a real shell (node-pty) in the chat's folder. */
test('терминал локального чата: кнопка открывает панель, echo даёт вывод', async () => {
  const { app, win } = await launchQclod()
  try {
    await win.locator('[data-testid="open-terminal"]').click()
    const drawer = win.locator('[data-testid="terminal-drawer"]')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.xterm-helper-textarea')).toBeFocused({ timeout: 15000 })
    await win.keyboard.type('echo qclod-ok\r')
    await expect(drawer).toContainText('qclod-ok', { timeout: 30000 })
  } finally {
    await app.close()
  }
})
