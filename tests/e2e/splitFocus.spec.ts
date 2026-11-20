import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('клик по правой панели делает её активной на месте, панели не переставляются', async () => {
  const other = mkdtempSync(join(tmpdir(), 'qclod-split-'))
  const profile = mkdtempSync(join(tmpdir(), 'qclod-splitfocus-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, QCLOD_USER_DATA: profile, QCLOD_PICK_FOLDER: other } as Record<string, string>
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').first().waitFor({ timeout: 15000 })
    await win.locator('[data-testid="tab-new"]').click()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })
    await win.locator('[data-testid="toggle-split"]').click()
    const panes = win.locator('[data-testid="chat-pane"]')
    await expect(panes).toHaveCount(2)

    const left = panes.first()
    const right = panes.last()
    const rightTab = await right.getAttribute('data-tab')

    await right.locator('[data-testid="composer-input"]').click()
    await expect(right).toHaveClass(/is-focused/)
    await expect(left).not.toHaveClass(/is-focused/)
    await win.keyboard.type('правый')
    await expect(right.locator('[data-testid="composer-input"]')).toHaveValue('правый')

    // Still the same pane on the right.
    await expect(panes.last()).toHaveAttribute('data-tab', rightTab ?? '')
  } finally {
    await app.close().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})
