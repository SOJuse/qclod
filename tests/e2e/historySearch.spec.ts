import { test, expect } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchQclod } from './helpers/launch'
import { writeTranscript } from '../fixtures/transcript.mjs'

const PHRASE = 'уникальнаяфраза'

test('Ctrl+K находит фразу в прошлом разговоре и открывает его чатом', async () => {
  // Two sessions on disk in this folder; only one of them says the phrase.
  const configDir = mkdtempSync(join(tmpdir(), 'qclod-search-config-'))
  const cwd = process.cwd()
  const at = new Date().toISOString()
  const turn = (id: string, asked: string, answered: string): object[] => [
    { type: 'user', cwd, sessionId: id, origin: { kind: 'human' }, message: { role: 'user', content: asked }, timestamp: at },
    { type: 'assistant', cwd, sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: answered }] }, timestamp: at }
  ]
  writeTranscript(configDir, cwd, '1a1a1a1a-0000-4000-8000-000000000001', turn('1a1a1a1a-0000-4000-8000-000000000001', 'почини вход', `нашёл: ${PHRASE} в логах`))
  writeTranscript(configDir, cwd, '2b2b2b2b-0000-4000-8000-000000000002', turn('2b2b2b2b-0000-4000-8000-000000000002', 'обнови readme', 'обновил'))

  const { app, win } = await launchQclod({ script: { steps: [] }, env: { CLAUDE_CONFIG_DIR: configDir } })
  try {
    await win.locator('[data-testid="composer-input"]').click()
    await win.keyboard.press('Control+k')
    await win.locator('[data-testid="action-query"]').fill(PHRASE)
    const rows = win.locator('[data-testid="action-item"][data-section="historyText"]')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('почини вход')
    await expect(rows.first().locator('mark')).toHaveText(PHRASE)
    await win.keyboard.press('Enter')

    const ribbon = win.locator('[data-testid="ribbon"]').last()
    await expect(ribbon).toContainText(PHRASE, { timeout: 15000 })
  } finally {
    await app.close()
    rmSync(configDir, { recursive: true, force: true, maxRetries: 3 })
  }
})
