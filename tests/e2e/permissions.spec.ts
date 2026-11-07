import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(script: unknown): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-perm-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(script)
    } as Record<string, string>
  })
  return { app, profile }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

test('запрос разрешения появляется в ленте на месте будущей карточки', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'text', text: 'сейчас запущу тесты' },
      { kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }
    ]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="permission-card"]')

    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card).toContainText('Bash')
    await expect(card).toContainText('npm test')

    // In the stream, after what the agent said — not in a modal over it.
    const order = await win.locator('[data-testid^="ribbon-"]').allTextContents()
    expect(order[0]).toContain('сейчас запущу тесты')
    expect(order[1]).toContain('npm test')
  } finally {
    await close(app, profile)
  }
})

test('«разрешить» пропускает инструмент и он выполняется', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="permission-allow"]').click({ timeout: 15000 })

    await expect(win.locator('[data-testid="permission-card"]')).toContainText('разрешено')
    await expect(win.locator('[data-testid="ribbon-tool"]')).toBeVisible({ timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('«отклонить» отменяет инструмент и агент продолжает', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'askPermission', name: 'Bash', input: { command: 'rm -rf /' } },
      { kind: 'text', text: 'хорошо, не буду' }
    ]
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="permission-deny"]').click({ timeout: 15000 })

    await expect(win.locator('[data-testid="permission-card"]')).toContainText('отклонено')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('хорошо, не буду', {
      timeout: 15000
    })
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('«разрешить всё такое» больше не спрашивает про такой же инструмент', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'askPermission', name: 'Read', input: { file_path: 'C:/проект/auth.ts' } },
      { kind: 'askPermission', name: 'Read', input: { file_path: 'C:/проект/auth.ts' } }
    ]
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="permission-allow-all"]').first().click({ timeout: 15000 })

    // The second identical call runs without asking a second time.
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(2, { timeout: 15000 })
    await expect(win.locator('[data-testid="permission-card"]')).toHaveCount(1)
  } finally {
    await close(app, profile)
  }
})

test('вопрос агента показывает варианты и отвечает выбранным', async () => {
  const { app, profile } = await launch({
    steps: [
      {
        kind: 'askQuestion',
        question: 'Какой вариант панели?',
        options: ['Справа', 'Снизу']
      }
    ],
    nextTurn: [{ kind: 'text', text: 'понял, делаю справа' }]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="question-card"]')

    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card).toContainText('Какой вариант панели?')
    await expect(card.locator('[data-testid="question-option"]')).toHaveCount(2)

    await card.locator('[data-testid="question-option"]', { hasText: 'Справа' }).click()

    // The choice is on the card, and the agent got it.
    await expect(card.locator('.is-chosen')).toContainText('Справа')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('понял, делаю справа', {
      timeout: 15000
    })
  } finally {
    await close(app, profile)
  }
})

test('пока ждём ответа, вкладка в состоянии waiting', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="permission-card"]')).toBeVisible({ timeout: 15000 })

    await expect(win.locator('[data-testid="tab"] .tab-status')).toHaveClass(/is-waiting/)

    await win.locator('[data-testid="permission-allow"]').click()
    await expect(win.locator('[data-testid="tab"] .tab-status')).not.toHaveClass(/is-waiting/, {
      timeout: 15000
    })
  } finally {
    await close(app, profile)
  }
})
