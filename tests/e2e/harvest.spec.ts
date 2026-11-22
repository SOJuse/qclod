import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchQclod } from './helpers/launch'
import { writeTranscript } from '../fixtures/transcript.mjs'

const ASKED = 'напиши тесты для модуля оплаты'
const ANSWERED = 'ответ ассистента, которого не должно быть в сборе'

/** Two projects' transcripts in a CLAUDE_CONFIG_DIR of the test's own. */
function configWithHistory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-harvest-claude-'))
  const at = new Date().toISOString()
  const line = (cwd: string, text: string): object[] => [
    { type: 'user', cwd, origin: { kind: 'human' }, message: { role: 'user', content: text }, timestamp: at },
    { type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'text', text: ANSWERED }] }, timestamp: at }
  ]
  writeTranscript(dir, 'C:\\shop', 's1', [...line('C:\\shop', ASKED), ...line('C:\\shop', 'сделай ревью ветки с картами')])
  writeTranscript(dir, 'C:\\blog', 's2', line('C:\\blog', 'переведи статью на английский'))
  return dir
}

/** Every file under dir with its hash: the transcripts must come out byte for byte the same. */
function hashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      if (statSync(path).isDirectory()) walk(path)
      else out[path] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return out
}

async function openHarvest(win: Page): Promise<ReturnType<Page['locator']>> {
  await win.locator('[data-testid="composer-input"]').click()
  await win.keyboard.press('Control+k')
  await win.locator('[data-testid="action-query"]').fill('Собрать мои')
  await win.locator('[data-testid="action-item"]', { hasText: 'Собрать мои шаблоны' }).click()
  const sheet = win.locator('[data-testid="harvest-sheet"]')
  await expect(sheet.locator('[data-testid="harvest-summary"]')).toBeVisible()
  return sheet
}

test('сводка, что уйдёт, сбор и сохранение отмеченного; транскрипты не тронуты', async () => {
  const config = configWithHistory()
  const before = hashes(config)
  const { app, win } = await launchQclod({ script: { steps: [] }, env: { CLAUDE_CONFIG_DIR: config } })
  try {
    const sheet = await openHarvest(win)
    await expect(sheet.locator('[data-testid="harvest-summary"]')).toContainText('3 сообщения из 2 разговоров в 2 проектах')
    await expect(sheet.locator('[data-testid="harvest-project"]')).toHaveCount(2)

    await sheet.locator('[data-testid="harvest-show"]').click()
    const items = sheet.locator('[data-testid="harvest-items"]')
    await expect(items).toContainText(ASKED)
    await expect(items).not.toContainText(ANSWERED)

    await sheet.locator('[data-testid="harvest-run"]').click()
    await expect(sheet.locator('[data-testid="harvest-proposal"]')).toHaveCount(2)
    await sheet.locator('[data-testid="harvest-pick"]').first().check()
    await expect(sheet.locator('[data-testid="harvest-save"]')).toHaveText('Сохранить отмеченные (1)')
    await sheet.locator('[data-testid="harvest-save"]').click()

    const manager = win.locator('[data-testid="template-manager"]')
    await expect(manager.locator('[data-testid="tpl-notice"]')).toHaveText('Сохранено: 1 шаблон.')
    await expect(manager.locator('[data-testid="tpl-item"]')).toContainText('из истории')
    await win.keyboard.press('Escape')

    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await input.press('/')
    await input.pressSequentially('рев')
    await expect(win.locator('[data-testid="slash-item"]', { hasText: 'Ревью ветки' })).toBeVisible()
  } finally {
    await app.close()
    expect(hashes(config)).toEqual(before)
    rmSync(config, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('«Остановить» во время запроса — снова сводка', async () => {
  const config = configWithHistory()
  const { app, win } = await launchQclod({
    script: { steps: [] },
    env: { CLAUDE_CONFIG_DIR: config, QCLOD_FAKE_ONESHOT: JSON.stringify({ delayMs: 5000 }) }
  })
  try {
    const sheet = await openHarvest(win)
    await sheet.locator('[data-testid="harvest-run"]').click()
    await expect(sheet.locator('[data-testid="harvest-running"]')).toBeVisible()
    await sheet.locator('[data-testid="harvest-stop"]').click()
    await expect(sheet.locator('[data-testid="harvest-summary"]')).toBeVisible()
    await expect(sheet.locator('[data-testid="harvest-proposal"]')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(config, { recursive: true, force: true, maxRetries: 3 })
  }
})
