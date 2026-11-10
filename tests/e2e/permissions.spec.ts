import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A card takes focus only when the window has been in front for a second before
 * the request, so the script rests that long first (a thinking block, which
 * adds nothing the tests count).
 */
const SETTLE = { kind: 'thinking', text: 'думаю', ms: 1300 }

/**
 * How long a scripted question waits before it arrives. The tests that must be
 * somewhere else (another pane, an open sheet) before it comes have a few
 * hundred ms of clicking to do; on a loaded machine that must stay far below
 * this.
 */
const ASK_AFTER_MS = 6000

/** Past every effect and timer the page queued in the frame that just rendered. */
async function afterEffects(win: Page): Promise<void> {
  await win.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))
      )
  )
}

async function launch(
  script: { steps: unknown[] } & Record<string, unknown>,
  settle = true
): Promise<{ app: ElectronApplication; profile: string }> {
  if (settle) script = { ...script, steps: [SETTLE, ...script.steps] }
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

/** The card's keys wake 400 ms after it takes focus. */
async function armed(win: Page): Promise<void> {
  await win.waitForTimeout(500)
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
  }, false)
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
      },
      // The answer releases the same turn: no second message is needed.
      { kind: 'text', text: 'понял, делаю справа' }
    ]
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

test('вопрос из двух частей: выбрал оба варианта — агент получил оба', async () => {
  const { app, profile } = await launch({
    steps: [
      {
        kind: 'askQuestion',
        questions: [
          { question: 'Где?', options: ['Слева', 'Справа'] },
          { question: 'Цвет?', options: ['Синий', 'Красный'] }
        ],
        echoAnswers: true
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="question-card"]')
    await expect(card).toBeVisible({ timeout: 15000 })

    const submit = card.locator('[data-testid="question-submit"]')
    await expect(submit).toBeDisabled()
    await card.locator('[data-testid="question-option"]', { hasText: 'Справа' }).click()
    // One question still open: the card does not answer by itself.
    await expect(submit).toBeDisabled()
    await card.locator('[data-testid="question-option"]', { hasText: 'Красный' }).click()
    await expect(submit).toBeEnabled()
    await submit.click()

    await expect(card.locator('.is-chosen')).toHaveCount(2)
    const ribbon = win.locator('[data-testid="ribbon"]')
    // What the agent itself received, not the card's own text.
    await expect(ribbon).toContainText('Получено: "Где?"="Справа", "Цвет?"="Красный"', {
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

test('Enter разрешает, инструмент выполняется', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="permission-card"]')
    await expect(card).toBeVisible({ timeout: 15000 })
    // The card took focus when it appeared.
    await expect(card).toBeFocused()

    await armed(win)
    await win.keyboard.press('Enter')

    await expect(card).toContainText('разрешено')
    await expect(win.locator('[data-testid="ribbon-tool"]')).toBeVisible({ timeout: 15000 })
    // Focus is back where the typing goes.
    await expect(win.locator('[data-testid="composer-input"]')).toBeFocused()
  } finally {
    await close(app, profile)
  }
})

test('Esc отклоняет', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'askPermission', name: 'Bash', input: { command: 'rm -rf /' } },
      { kind: 'text', text: 'хорошо, не буду' }
    ]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="permission-card"]')
    await expect(card).toBeFocused({ timeout: 15000 })

    await armed(win)
    await win.keyboard.press('Escape')

    await expect(card).toContainText('отклонено')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('хорошо, не буду', {
      timeout: 15000
    })
  } finally {
    await close(app, profile)
  }
})

test('A разрешает всё такое — второй такой же не спрашивается', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'askPermission', name: 'Read', input: { file_path: 'C:/проект/auth.ts' } },
      { kind: 'askPermission', name: 'Read', input: { file_path: 'C:/проект/auth.ts' } }
    ]
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="permission-card"]')).toBeFocused({ timeout: 15000 })

    // The physical key: it is «ф» on the Russian layout.
    await armed(win)
    await win.keyboard.press('KeyA')

    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(2, { timeout: 15000 })
    await expect(win.locator('[data-testid="permission-card"]')).toHaveCount(1)
  } finally {
    await close(app, profile)
  }
})

test('в поле ввода A и Enter ничего не разрешают', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="permission-card"]')
    await expect(card).toBeFocused({ timeout: 15000 })

    // Back to the input line with a click, then a reply that starts with «ф».
    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await win.keyboard.press('KeyA')
    await win.keyboard.press('Enter')
    await expect(input).toBeFocused()
    await expect(card).toContainText('npm test')
    await expect(win.locator('[data-testid="permission-allow"]')).toBeVisible()
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('карточка не прячется под полем ввода', async () => {
  const steps: unknown[] = Array.from({ length: 20 }, (_, i) => ({
    kind: 'text',
    text: `шаг ${i + 1}: читаю файлы и думаю дальше`
  }))
  steps.push({ kind: 'askPermission', name: 'Bash', input: { command: 'первый' } })
  steps.push({ kind: 'askPermission', name: 'Bash', input: { command: 'второй' } })
  const { app, profile } = await launch({ steps })
  try {
    const win = await app.firstWindow()
    const first = win.locator('[data-testid="permission-card"]', { hasText: 'первый' })
    await expect(first).toBeVisible({ timeout: 20000 })

    // Read back up the story, then answer; the next question arrives while
    // the ribbon is scrolled away from the bottom.
    // Two frames, so the ribbon has heard that it is no longer following the bottom.
    await win.locator('[data-testid="ribbon"]').evaluate(async (el) => {
      el.scrollTop = 0
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    })
    await armed(win)
    await win.keyboard.press('Enter')

    const second = win.locator('[data-testid="permission-card"]', { hasText: 'второй' })
    await expect(second).toBeVisible({ timeout: 15000 })
    await expect
      .poll(async () => {
        const card = await second.boundingBox()
        const composer = await win.locator('[data-testid="composer"]').boundingBox()
        return card !== null && composer !== null && card.y + card.height <= composer.y
      })
      .toBe(true)
  } finally {
    await close(app, profile)
  }
})

test('«Разрешить» — главная кнопка, «Отклонить» — опасная', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="permission-allow"]')).toHaveClass(/btn-primary/, {
      timeout: 15000
    })
    await expect(win.locator('[data-testid="permission-deny"]')).toHaveClass(/btn-danger/)
    await expect(win.locator('[data-testid="permission-allow-all"]')).not.toHaveClass(
      /btn-primary|btn-danger/
    )
    await expect(win.locator('[data-testid="permission-allow"] kbd')).toHaveText('Enter')
    await expect(win.locator('[data-testid="permission-allow-all"] kbd')).toHaveText('A')
    await expect(win.locator('[data-testid="permission-deny"] kbd')).toHaveText('Esc')
    await expect(win.locator('[data-testid="permission-deny"]')).toHaveAttribute('title', /Esc/)
  } finally {
    await close(app, profile)
  }
})

test('запрос в соседней панели не уводит фокус из той, где пишешь', async () => {
  const other = mkdtempSync(join(tmpdir(), 'qclod-split-'))
  const profile = mkdtempSync(join(tmpdir(), 'qclod-perm-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_PICK_FOLDER: other,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({
        steps: [{ kind: 'text', text: 'первый чат' }],
        // The question arrives a few seconds after the message is sent.
        nextTurn: [
          { kind: 'tool', name: 'Read', input: { file_path: 'a.ts' }, result: 'x', pauseMs: ASK_AFTER_MS },
          { kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }
        ]
      })
    } as Record<string, string>
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').first().waitFor({ timeout: 15000 })
    await win.locator('[data-testid="tab-new"]').click()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })
    await win.locator('[data-testid="toggle-split"]').click()
    await expect(win.locator('[data-testid="chat-pane"]')).toHaveCount(2)

    const left = win.locator('[data-testid="chat-pane"]').first()
    const right = win.locator('[data-testid="chat-pane"]').last()

    // The right pane asks; then the person goes to the left one and types.
    await right.locator('[data-testid="composer-input"]').click()
    await win.keyboard.type('сделай')
    await win.keyboard.press('Enter')
    await left.locator('[data-testid="composer-input"]').click()
    await expect(left).toHaveClass(/is-focused/)

    await expect(right.locator('[data-testid="permission-card"]')).toBeVisible({ timeout: 15000 })

    await afterEffects(win)
    // Focus stayed, so what is typed now lands in the pane being written in.
    await expect(left.locator('[data-testid="composer-input"]')).toBeFocused()
    await win.keyboard.type('левый черновик')
    await expect(left.locator('[data-testid="composer-input"]')).toHaveValue('левый черновик')
    await expect(right.locator('[data-testid="permission-allow"]')).toBeVisible()
  } finally {
    await app.close().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test('A в первые 400 мс после появления карточки ничего не делает, потом разрешает всё такое', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'askPermission', name: 'Read', input: { file_path: 'C:/проект/auth.ts' } },
      { kind: 'askPermission', name: 'Read', input: { file_path: 'C:/проект/auth.ts' } }
    ]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="permission-card"]')
    await expect(card).toBeFocused({ timeout: 15000 })

    // A keystroke that was already on its way when the card appeared.
    await win.keyboard.press('KeyA')
    await expect(win.locator('[data-testid="permission-allow"]')).toBeVisible()
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(0)

    // Armed: a fresh press answers.
    await armed(win)
    await win.keyboard.press('KeyA')
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(2, { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('Enter в пустом поле ввода при ожидающей карточке ничего не разрешает', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="permission-card"]')).toBeFocused({ timeout: 15000 })
    await armed(win)
    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await win.keyboard.press('Enter')
    await expect(win.locator('[data-testid="permission-allow"]')).toBeVisible()
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('Enter и Пробел на сфокусированной кнопке в первые 400 мс ничего не делают', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="permission-card"]')
    await expect(card).toBeFocused({ timeout: 15000 })
    // Tab walks onto the buttons; focus entering the card arms it afresh.
    const allowAll = win.locator('[data-testid="permission-allow-all"]')
    await allowAll.focus()
    await win.keyboard.press('Enter')
    await win.keyboard.press('Space')
    await expect(win.locator('[data-testid="permission-allow"]')).toBeVisible()
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(0)

    // Armed now: a fresh Enter on the focused button answers.
    await armed(win)
    await win.keyboard.press('Enter')
    await expect(win.locator('[data-testid="ribbon-tool"]')).toBeVisible({ timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('открытые настройки не теряют фокус, когда приходит запрос', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'text', text: 'готов' }],
    nextTurn: [
      { kind: 'tool', name: 'Read', input: { file_path: 'a.ts' }, result: 'x', pauseMs: ASK_AFTER_MS },
      { kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }
    ]
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('готов', { timeout: 15000 })
    const input = win.locator('[data-testid="composer-input"]')
    await input.fill('сделай')
    await win.keyboard.press('Enter')
    await win.locator('[data-testid="open-settings"]').click()
    const settings = win.locator('[data-testid="settings"]')
    await expect(settings).toBeVisible()

    await expect(win.locator('[data-testid="permission-card"]')).toBeVisible({ timeout: 15000 })
    await afterEffects(win)
    // Focus is still inside the sheet, and the keys act on the sheet.
    expect(await win.evaluate(() => !!document.activeElement?.closest('[data-testid="settings"]'))).toBe(true)
    await win.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await expect(win.locator('[data-testid="permission-allow"]')).toBeVisible()
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(1)
  } finally {
    await close(app, profile)
  }
})
