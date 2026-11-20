import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
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
  await expect(panel.locator('[data-testid="panel-model"]')).toContainText('Opus 5')
  await expect(win.locator('[data-testid="status-model"]').first()).toHaveAttribute('data-value', 'claude-opus-5')

  // The subagents are the ribbon's cards; the panel no longer lists them (its «Агенты» layer is этап 4).
  await expect(panel.locator('[data-testid="panel-agents"]')).toHaveCount(0)
  const ribbon = win.locator('[data-testid="ribbon"]:visible')
  const agents = ribbon.locator('[data-testid="subagent-head"]')
  await expect(agents).toHaveCount(4)
  const texts = await agents.allInnerTexts()
  const count = (word: string): number => texts.filter((t) => t.includes(word)).length
  expect(count('готов')).toBe(2)
  expect(count('ошибка')).toBe(1)
  expect(count('не закончил')).toBe(1)
  expect(texts.find((t) => t.includes('Прогон тестов'))).toContain('93k токенов')

  await expect(ribbon.locator('[data-testid="ribbon-user"]').first()).toContainText(
    'найди, где падает вставка',
    { timeout: 15000 }
  )
  await expect(ribbon.locator('[data-testid="ribbon-compaction"]')).toHaveCount(1)
  // Notices the CLI wrote for itself are not the person's words.
  const bubbles = await ribbon.locator('[data-testid="ribbon-user"]').allInnerTexts()
  // Nothing was sent: only what the history holds. The fixture has three
  // (the question, the follow-up, the text typed mid-turn); the rewound
  // branch and the compaction summary are not bubbles.
  expect(bubbles).toHaveLength(3)
  for (const text of bubbles) {
    expect(text).not.toContain('task-notification')
    expect(text).not.toContain('This session is being conti')
  }
}

async function launch(): Promise<{ app: ElectronApplication; cleanup: () => Promise<void> }> {
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
  return {
    app,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      for (const dir of [profile, configDir, project]) rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('восстановленная сессия: панель и подагенты видны до первого сообщения', async () => {
  const { app, cleanup } = await launch()
  try {
    const win = await app.firstWindow()
    const panel = win.locator('[data-testid="side-panel"]')
    await expect(panel).toBeVisible({ timeout: 15000 })
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2)
    await expectFullPanel(win, panel)
  } finally {
    await cleanup()
  }
})

test('вторая вкладка до клика уже содержит свою ленту и подагентов', async () => {
  const { app, cleanup } = await launch()
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })
    const second = win.locator('[data-testid="tab"]').nth(1)
    // No process behind it yet: starting one is what the switch does, so the
    // proof is the state before the click and an answer within 3 s after it.
    await expect(second).toHaveAttribute('title', /не запущена/)
    await second.click()
    const panel = win.locator('[data-testid="side-panel"]')
    await expect(win.locator('[data-testid="ribbon"]:visible [data-testid="subagent-head"]')).toHaveCount(4, { timeout: 3000 })
    await expectFullPanel(win, panel)
  } finally {
    await cleanup()
  }
})

test('после перезагрузки окна всё на месте', async () => {
  const { app, cleanup } = await launch()
  try {
    const win = await app.firstWindow()
    const panel = win.locator('[data-testid="side-panel"]')
    await expect(panel).toBeVisible({ timeout: 15000 })
    await expectFullPanel(win, panel)

    await win.reload()

    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible({ timeout: 15000 })
    await expectFullPanel(win, win.locator('[data-testid="side-panel"]'))
  } finally {
    await cleanup()
  }
})
