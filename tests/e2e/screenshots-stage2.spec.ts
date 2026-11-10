import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Not an assertion: the owner's look at every main surface of stage 2.
 * `QCLOD_SHOT_DIR=<dir> QCLOD_SHOT=1 npx playwright test screenshots-stage2`.
 * Always against the fake SDK (playwright.config.ts sets QCLOD_FAKE_SDK).
 */
test.skip(process.env['QCLOD_SHOT'] !== '1', 'снимки делаются только по QCLOD_SHOT=1')

const DIR = process.env['QCLOD_SHOT_DIR'] ?? 'tests/.artifacts/stage2'
mkdirSync(DIR, { recursive: true })

async function launch(
  script: unknown,
  extra: Record<string, string> = {},
  tabs?: unknown
): Promise<{ app: ElectronApplication; profile: string; win: Page }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-shot-'))
  if (tabs) writeFileSync(join(profile, 'tabs.json'), JSON.stringify(tabs), 'utf8')
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(script),
      ...extra
    } as Record<string, string>
  })
  const win = await app.firstWindow()
  await win.locator('[data-testid="composer-input"]').first().waitFor({ timeout: 15000 })
  return { app, profile, win }
}

async function done(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

async function shot(win: Page, name: string): Promise<void> {
  await win.waitForTimeout(500)
  await win.screenshot({ path: join(DIR, `${name}.png`) })
}

async function send(win: Page, text: string): Promise<void> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

const STEPS = [
  { kind: 'text', text: 'Смотрю, как устроен вход.' },
  {
    kind: 'tool', name: 'Read', input: { file_path: 'C:/проект/auth.ts' }, result: 'строка 1\nстрока 2',
    output: { type: 'text', file: { filePath: 'C:/проект/auth.ts', content: 'строка 1\nстрока 2', numLines: 2, startLine: 1, totalLines: 2 } }
  },
  {
    kind: 'tool', name: 'Grep', input: { pattern: 'login', path: 'src' }, result: 'src/a.ts\nsrc/b.ts',
    output: { mode: 'files_with_matches', numFiles: 2, filenames: ['src/a.ts', 'src/b.ts'] }
  },
  {
    kind: 'tool', name: 'Edit', input: { file_path: 'C:/проект/a.ts', old_string: 'b', new_string: 'c\nd' },
    result: 'The file has been updated.',
    output: { filePath: 'C:/проект/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }] }
  },
  {
    kind: 'tool', name: 'Bash', input: { command: 'npm test', description: 'Run tests' }, result: 'ok',
    output: { stdout: 'ok\n12 тестов прошло', stderr: 'warn', interrupted: false }
  },
  { kind: 'tool', name: 'mcp__gh__x', input: { title: 'Баг', labels: ['a'] }, result: 'создано' },
  { kind: 'text', text: 'Готово. Правил `src/a.ts:3`.' }
]

const COMMANDS = [
  { name: 'compact', description: 'Сжать контекст', argumentHint: '', builtin: true },
  { name: 'model', description: 'Сменить модель', argumentHint: '<model>', builtin: true },
  { name: 'resume', description: 'Открыть прошлую сессию', argumentHint: '', builtin: true },
  { name: 'моя-команда', description: 'Команда из этого проекта', argumentHint: '' }
]

test('01 пустая вкладка', async () => {
  const { app, profile, win } = await launch({ steps: [] })
  await expect(win.locator('[data-testid="empty-tab"]')).toBeVisible()
  await shot(win, '01-empty-tab')
  await done(app, profile)
})

test('02-03 лента с карточками, свёрнутыми и раскрытыми', async () => {
  const { app, profile, win } = await launch({ steps: STEPS })
  await expect(win.locator('.tool-card')).toHaveCount(5, { timeout: 15000 })
  await shot(win, '02-chat-folded')
  for (const c of ['edit', 'command']) {
    await win.locator(`.tool-card[data-category="${c}"] [data-testid="tool-head"]`).first().click()
  }
  await shot(win, '03-chat-open')
  await done(app, profile)
})

test('04 подагент с раскрытой лентой', async () => {
  const { app, profile, win } = await launch({
    steps: [
      {
        kind: 'subagent', name: 'найти вход', agentType: 'Explore',
        stats: { totalTokens: 4000, totalDurationMs: 12000, totalToolUseCount: 2 },
        report: 'Нашёл два места:\n- src/a.ts\n- src/b.ts',
        steps: [STEPS[1], STEPS[2], { kind: 'text', text: 'просмотрел оба файла' }]
      }
    ]
  })
  const card = win.locator('[data-testid="ribbon-subagent"]').first()
  await expect(card).toBeVisible({ timeout: 15000 })
  await card.locator('[data-testid="subagent-head"]').click()
  await shot(win, '04-subagent-open')
  await done(app, profile)
})

test('05-06 строка статуса на 13% и плашка на 92%', async () => {
  const { app, profile, win } = await launch({ steps: [], contextPercent: 13, contextPercentByTurn: [92] })
  await expect(win.locator('[data-testid="status-context"]')).toContainText('13%', { timeout: 15000 })
  await shot(win, '05-status-13')
  await send(win, 'привет')
  await expect(win.locator('[data-testid="context-banner"]')).toBeVisible({ timeout: 15000 })
  await shot(win, '06-status-92-banner')
  await done(app, profile)
})

test('07 список / и второй шаг /model', async () => {
  const { app, profile, win } = await launch({ steps: [], init: { commands: COMMANDS } })
  const input = win.locator('[data-testid="composer-input"]')
  await input.click()
  await input.press('/')
  await expect(win.locator('[data-testid="slash-menu"]')).toBeVisible()
  await shot(win, '07-slash-list')
  // Typed and chosen the way a person does; fill() skips the menu altogether.
  await input.pressSequentially('model')
  await input.press('Enter')
  // The second step is the model list; the shot is of it, not of the command list.
  const items = win.locator('[data-testid="slash-item"]')
  await expect(items).toHaveCount(2)
  await expect(items.nth(1)).toContainText('Sonnet 5')
  await shot(win, '07b-slash-model')
  await done(app, profile)
})

test('08 палитра Ctrl+K', async () => {
  const { app, profile, win } = await launch({ steps: [] })
  await win.keyboard.press('Control+k')
  await expect(win.locator('[data-testid="action-palette"]')).toBeVisible()
  await shot(win, '08-palette')
  await done(app, profile)
})

test('09 меню пути', async () => {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'qclod-shot-proj-')))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  const { app, profile, win } = await launch(
    { steps: [{ kind: 'text', text: 'Правил src/a.ts:3 и ещё кое-что.' }] },
    { QCLOD_FAKE_SHELL: '1' },
    [{ id: 'a', cwd: project, title: 'Пути', overrides: {} }]
  )
  const link = win.locator('[data-testid="path-link"]').first()
  await expect(link).toBeVisible({ timeout: 15000 })
  await link.click({ button: 'right' })
  await expect(win.locator('[data-testid="path-menu"]')).toBeVisible()
  await shot(win, '09-path-menu')
  await done(app, profile)
  rmSync(project, { recursive: true, force: true })
})

test('10 карточка разрешения', async () => {
  const { app, profile, win } = await launch({
    steps: [
      { kind: 'text', text: 'Сейчас запущу тесты.' },
      { kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }
    ]
  })
  await expect(win.locator('[data-testid="permission-card"]')).toBeVisible({ timeout: 15000 })
  await shot(win, '10-permission-card')
  await done(app, profile)
})

test('11 список фоновых задач', async () => {
  const { app, profile, win } = await launch({
    steps: [],
    nextTurn: [{ kind: 'backgroundBash', command: 'npm run dev', chunks: ['готово 1\n', 'готово 2\n'], pauseMs: 200, finish: null }]
  })
  await send(win, 'запусти сервер')
  const counter = win.locator('[data-testid="status-bg"]')
  await expect(counter).toHaveText('Фоновые 1', { timeout: 15000 })
  await counter.click()
  await win.locator('[data-testid="bg-task-toggle"]').click()
  await expect(win.locator('[data-testid="bg-output"]')).toContainText('готово 2', { timeout: 5000 })
  await shot(win, '11-background-tasks')
  await done(app, profile)
})

test('12 полоска очереди и строка «сейчас»', async () => {
  const { app, profile, win } = await launch({
    steps: [],
    turns: [[{ kind: 'textStream', pieces: ['думаю ', 'ещё ', 'немного ', 'готово'], pauseMs: 4000 }]],
    nextTurn: [{ kind: 'text', text: 'закоммитил' }]
  })
  await send(win, 'сделай фичу')
  await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 15000 })
  await send(win, 'и потом закоммить')
  await expect(win.locator('[data-testid="queue-item"]')).toBeVisible()
  await shot(win, '12-queue-strip')
  await done(app, profile)
})

test('13-14 настройки и история', async () => {
  const { app, profile, win } = await launch({ steps: [{ kind: 'text', text: 'готов' }] })
  await win.locator('[data-testid="open-settings"]').click()
  await expect(win.locator('[data-testid="settings"]')).toBeVisible()
  await shot(win, '13-settings')
  await win.keyboard.press('Escape')
  await win.locator('[data-testid="open-history"]').click()
  await expect(win.locator('[data-testid="history-screen"]')).toBeVisible()
  await shot(win, '14-history')
  await done(app, profile)
})
