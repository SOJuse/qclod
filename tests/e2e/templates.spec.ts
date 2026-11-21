import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchQclod } from './helpers/launch'

/** A profile with one template already saved (userData/templates.json). */
function profileWithTemplate(): string {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-templates-'))
  const now = Date.now()
  writeFileSync(
    join(profile, 'templates.json'),
    JSON.stringify({
      version: 1,
      templates: [
        { id: 'review', title: 'Ревью ветки', body: 'Сделай ревью {{ветки}} и перечисли проблемы', origin: 'manual', createdAt: now, updatedAt: now }
      ]
    }),
    'utf8'
  )
  return profile
}

async function selectedText(win: Page): Promise<string> {
  return win.locator('[data-testid="composer-input"]').evaluate((el) => {
    const field = el as HTMLTextAreaElement
    return field.value.slice(field.selectionStart, field.selectionEnd)
  })
}

test('шаблон из списка / встаёт в поле, {{…}} выделено, ничего не ушло', async () => {
  const profile = profileWithTemplate()
  const { app, win } = await launchQclod({ script: { steps: [] }, env: { QCLOD_USER_DATA: profile } })
  try {
    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await input.press('/')
    await input.pressSequentially('ре')
    const row = win.locator('[data-testid="slash-item"]', { hasText: 'Ревью ветки' })
    await expect(row).toBeVisible()
    await expect(row).toContainText('шаблон')
    await row.click()
    await expect(input).toHaveValue('Сделай ревью {{ветки}} и перечисли проблемы')
    expect(await selectedText(win)).toBe('{{ветки}}')
    await expect(win.locator('.row-user')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('Ctrl+K «Шаблоны» вставляет текст на место курсора в середине черновика', async () => {
  const profile = profileWithTemplate()
  const { app, win } = await launchQclod({ script: { steps: [] }, env: { QCLOD_USER_DATA: profile } })
  try {
    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await input.fill('начало  конец')
    await input.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(7, 7))
    await win.keyboard.press('Control+k')
    await win.locator('[data-testid="action-query"]').fill('ревью ветки')
    const row = win.locator('[data-testid="action-item"][data-section="templates"]').first()
    await expect(row).toContainText('Ревью ветки')
    await win.keyboard.press('Enter')
    await expect(input).toHaveValue('начало Сделай ревью {{ветки}} и перечисли проблемы конец')
    await expect(input).toBeFocused()
    expect(await selectedText(win)).toBe('{{ветки}}')
  } finally {
    await app.close()
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  }
})
