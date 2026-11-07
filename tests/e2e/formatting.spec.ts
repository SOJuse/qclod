import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(
  script: unknown,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-format-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(script),
      ...extraEnv
    } as Record<string, string>
  })
  return { app, profile }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

const ANSWER = [
  '## Что я нашёл',
  '',
  'В `auth.ts` **две** проблемы:',
  '',
  '1. токен не обновляется',
  '2. ошибка проглатывается',
  '',
  '```ts',
  'const token = await refresh()',
  '```',
  '',
  '| файл | строк |',
  '| --- | --- |',
  '| auth.ts | 120 |'
].join('\n')

test('ответ агента показан разметкой, а не сырым текстом', async () => {
  const { app, profile } = await launch({ steps: [{ kind: 'text', text: ANSWER }] })
  try {
    const win = await app.firstWindow()
    const row = win.locator('[data-testid="ribbon-agentText"]').first()
    await expect(row).toBeVisible({ timeout: 15000 })

    // Heading, bold, list, table and code are elements — not asterisks.
    await expect(row.locator('h3, h2')).toContainText('Что я нашёл')
    await expect(row.locator('strong')).toContainText('две')
    await expect(row.locator('ol li')).toHaveCount(2)
    await expect(row.locator('table td').first()).toContainText('auth.ts')
    await expect(row.locator('[data-testid="md-code"]')).toContainText('refresh')

    await expect(row).not.toContainText('**')
    await expect(row).not.toContainText('```')
  } finally {
    await close(app, profile)
  }
})

test('код в ответе подсвечен и копируется', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'text', text: '```ts\nconst answer = 42 // ответ\n```' }]
  })
  try {
    const win = await app.firstWindow()
    const code = win.locator('[data-testid="md-code"]').first()
    await expect(code).toBeVisible({ timeout: 15000 })

    await expect(code.locator('.tok-keyword')).toContainText('const')
    await expect(code.locator('.tok-number')).toContainText('42')
    await expect(code.locator('.tok-comment')).toContainText('ответ')
    await expect(code.locator('[data-testid="md-copy"]')).toBeVisible()
  } finally {
    await close(app, profile)
  }
})

test('подагент показывает задачу, время и токены', async () => {
  const { app, profile } = await launch({
    steps: [
      {
        kind: 'subagent',
        name: 'найти утечку памяти',
        agentType: 'Explore',
        stats: { durationMs: 42000, usage: { input_tokens: 12000, output_tokens: 3000 }, toolUseCount: 7 },
        steps: [{ kind: 'tool', name: 'Grep', input: { pattern: 'leak' }, result: 'три места' }]
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="ribbon-subagent"]').first()
    await expect(card).toBeVisible({ timeout: 15000 })

    await expect(card).toContainText('Explore')
    await expect(card).toContainText('найти утечку памяти')

    const stats = card.locator('[data-testid="subagent-stats"]')
    await expect(stats).toContainText('42 с')
    await expect(stats).toContainText('15k токенов')
    await expect(stats).toContainText('7 вызовов')
  } finally {
    await close(app, profile)
  }
})

test('вставленное системой не показывается как слова пользователя', async () => {
  const history = {
    sessions: [{ sessionId: 'старая', summary: 'Вчера', lastModified: Date.now() }],
    messages: {
      старая: [
        {
          type: 'user',
          message: {
            role: 'user',
            content:
              'почини вставку\n<system-reminder>Напоминание системы, которое никто не писал.</system-reminder>'
          }
        },
        {
          type: 'assistant',
          message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'починил' }] }
        }
      ]
    }
  }

  const { app, profile } = await launch({ steps: [] }, { QCLOD_FAKE_HISTORY: JSON.stringify(history) })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 15000 })
    await win.keyboard.press('Control+H')
    await win.locator('[data-testid="history-item"]').first().click()

    const ribbon = win.locator('[data-testid="ribbon"]')
    await expect(ribbon).toContainText('почини вставку', { timeout: 15000 })
    await expect(ribbon).not.toContainText('system-reminder')
    await expect(ribbon).not.toContainText('Напоминание системы')
  } finally {
    await close(app, profile)
  }
})

test('открытая из истории переписка на месте, и своё сообщение не теряется', async () => {
  const history = {
    sessions: [{ sessionId: 'старая', summary: 'Вчерашний разговор', lastModified: Date.now() }],
    messages: {
      старая: [
        { type: 'user', message: { role: 'user', content: 'что было вчера' } },
        {
          type: 'assistant',
          message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'вот что было' }] }
        }
      ]
    }
  }

  const { app, profile } = await launch(
    { steps: [], nextTurn: [{ kind: 'text', text: 'продолжаю' }] },
    { QCLOD_FAKE_HISTORY: JSON.stringify(history) }
  )
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await win.keyboard.press('Control+H')
    await win.locator('[data-testid="history-item"]').first().click()

    const ribbon = win.locator('[data-testid="ribbon"]')
    await expect(ribbon).toContainText('вот что было', { timeout: 15000 })

    // Sending must not wipe the conversation, and must not lose the message.
    await input.click()
    await input.fill('а теперь дальше')
    await input.press('Enter')

    await expect(ribbon).toContainText('а теперь дальше')
    await expect(ribbon).toContainText('вот что было')
    await expect(ribbon).toContainText('продолжаю', { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('переключение вкладок возвращает к концу разговора, а не наверх', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    kind: 'text' as const,
    text: `реплика ${i}`
  }))
  const other = mkdtempSync(join(tmpdir(), 'qclod-other-'))
  writeFileSync(join(other, 'файл.ts'), 'x', 'utf8')

  const { app, profile } = await launch({ steps: many }, { QCLOD_PICK_FOLDER: other })
  try {
    const win = await app.firstWindow()
    const ribbon = win.locator('[data-testid="ribbon"]')
    await expect(ribbon).toContainText('реплика 59', { timeout: 20000 })

    await win.locator('[data-testid="tab-new"]').click()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })

    await win.locator('[data-testid="tab"]').first().click()

    // Back at the end of the conversation, where the work is.
    await expect(ribbon).toContainText('реплика 59', { timeout: 15000 })
    const atBottom = await ribbon.evaluate(
      (el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 40
    )
    expect(atBottom).toBe(true)
  } finally {
    await close(app, profile)
    rmSync(other, { recursive: true, force: true })
  }
})
