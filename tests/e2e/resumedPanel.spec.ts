import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resumedSession, writeTranscript } from '../fixtures/transcript.mjs'

const SESSION_A = '0f0e0d0c-0b0a-4908-8706-050403020101'
const SESSION_B = '0f0e0d0c-0b0a-4908-8706-050403020102'

/** Everything the owner expects to see before sending a single message. */
async function expectFullPanel(win: Page, panel: Locator): Promise<void> {
  await expect(panel.locator('[data-testid="panel-context"]')).toContainText('%', { timeout: 15000 })
  const limits = panel.locator('[data-testid="panel-limits"]')
  await expect(limits).toContainText('13%')
  await expect(limits).toContainText('38%')
  await expect(panel.locator('[data-testid="panel-model"]')).toHaveValue('claude-opus-5')

  const agents = panel.locator('[data-testid="panel-agents"] li')
  await expect(agents).toHaveCount(4)
  const texts = await agents.allInnerTexts()
  const count = (word: string): number => texts.filter((t) => t.includes(word)).length
  expect(count('готов')).toBe(2)
  expect(count('ошибка')).toBe(1)
  expect(count('не закончил')).toBe(1)
  expect(texts.find((t) => t.includes('Прогон тестов'))).toContain('93k токенов')

  const ribbon = win.locator('[data-testid="ribbon"]:visible')
  await expect(ribbon.locator('[data-testid="ribbon-user"]').first()).toContainText(
    'найди, где падает вставка',
    { timeout: 15000 }
  )
  await expect(ribbon.locator('[data-testid="ribbon-compaction"]')).toHaveCount(1)
  // Notices the CLI wrote for itself are not the person's words.
  const bubbles = await ribbon.locator('[data-testid="ribbon-user"]').allInnerTexts()
  expect(bubbles.length).toBeGreaterThan(0)
  for (const text of bubbles) {
    expect(text).not.toContain('task-notification')
    expect(text).not.toContain('This session is being conti')
  }
}

test('восстановленная сессия: панель и подагенты видны до первого сообщения', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'qclod-config-'))
  const project = mkdtempSync(join(tmpdir(), 'qclod-project-'))
  const profile = mkdtempSync(join(tmpdir(), 'qclod-resumed-'))
  for (const id of [SESSION_A, SESSION_B]) {
    const session = resumedSession(id, project)
    writeTranscript(configDir, project, id, session.lines, session.subagents)
  }
  writeFileSync(
    join(profile, 'tabs.json'),
    JSON.stringify([
      { id: 'a', cwd: project, title: 'Первая', overrides: {}, lastSessionId: SESSION_A },
      { id: 'b', cwd: project, title: 'Вторая', overrides: {}, lastSessionId: SESSION_B }
    ]),
    'utf8'
  )

  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      CLAUDE_CONFIG_DIR: configDir,
      // The fake is silent until the first message, like the real CLI.
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({ steps: [] })
    } as Record<string, string>
  })
  try {
    const win = await app.firstWindow()
    const panel = win.locator('[data-testid="side-panel"]')
    await expect(panel).toBeVisible({ timeout: 15000 })
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2)

    // The tab that opens first, with nothing sent.
    await expectFullPanel(win, panel)

    // The other restored tab, opened for the first time, still nothing sent.
    await win.locator('[data-testid="tab"]').nth(1).click()
    await expectFullPanel(win, win.locator('[data-testid="side-panel"]'))
  } finally {
    await app.close().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
