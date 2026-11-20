import { test, expect, type Page } from '@playwright/test'
import { launchQclod } from './helpers/launch'

/**
 * Stage 3, end to end: «авто-да» answers a card nobody answered, touching the
 * card stops it, «спрашивать» never answers, and a crash mid-turn carries on
 * with «продолжай» marked «авто». Run in task 12, after `npm run build:e2e`.
 */
const SEAMS = {
  QCLOD_AUTO_ANSWER_MS: '1500',
  QCLOD_CONFIRM_AUTO_ALLOW: 'allow',
  QCLOD_AUTONOMY_NO_JITTER: '1'
}

const QUESTION = {
  kind: 'askQuestion',
  question: 'Продолжать?',
  options: ['Нет', 'Да (Recommended)'],
  echoAnswers: true
}

async function chooseMode(win: Page, mode: string): Promise<void> {
  await win.locator('[data-testid="status-mode"]').click()
  await win.locator(`[data-testid="status-mode-option"][data-id="${mode}"]`).click()
  await expect(win.locator('[data-testid="status-mode"]')).toHaveAttribute('data-value', mode, { timeout: 15000 })
}

async function say(win: Page, text: string): Promise<void> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

test('вопрос в «авто-да»: отсчёт на карточке, по сроку ответ «Да (Recommended)» с пометкой «авто»', async () => {
  const { app, win } = await launchQclod({ script: { steps: [], nextTurn: [QUESTION] }, env: SEAMS })
  try {
    await chooseMode(win, 'autoAllow')
    await say(win, 'спроси')
    const card = win.locator('[data-testid="question-card"]')
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(win.locator('[data-testid="auto-answer"]')).toBeVisible()

    const summary = win.locator('[data-testid="card-summary"]')
    await expect(summary).toBeVisible({ timeout: 10000 })
    await expect(summary.locator('[data-testid="auto-tag"]')).toHaveCount(1)
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('="Да (Recommended)"', { timeout: 15000 })
  } finally {
    await app.close()
  }
})

test('клик внутрь карточки до срока: ответа нет и через 3 с', async () => {
  const { app, win } = await launchQclod({ script: { steps: [], nextTurn: [QUESTION] }, env: SEAMS })
  try {
    await chooseMode(win, 'autoAllow')
    await say(win, 'спроси')
    const card = win.locator('[data-testid="question-card"]')
    await expect(card).toBeVisible({ timeout: 15000 })
    await card.locator('[data-testid="question-option"]', { hasText: 'Нет' }).click()

    await win.waitForTimeout(3000)
    await expect(card).toBeVisible()
    await expect(win.locator('[data-testid="auto-answer"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="card-summary"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('режим «спрашивать»: ответа нет и через 3 с', async () => {
  const { app, win } = await launchQclod({ script: { steps: [], nextTurn: [QUESTION] }, env: SEAMS })
  try {
    await say(win, 'спроси')
    const card = win.locator('[data-testid="question-card"]')
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(win.locator('[data-testid="auto-answer"]')).toHaveCount(0)

    await win.waitForTimeout(3000)
    await expect(card).toBeVisible()
    await expect(win.locator('[data-testid="card-summary"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('падение посреди хода: в ленте пузырь «продолжай» с пометкой «авто»', async () => {
  const { app, win } = await launchQclod({
    script: {
      steps: [],
      nextTurn: [
        { kind: 'text', text: 'начал' },
        { kind: 'crash', message: 'агент упал', times: 1 },
        { kind: 'text', text: 'закончил' }
      ]
    },
    env: SEAMS
  })
  try {
    await say(win, 'делай')
    const bubble = win.locator('[data-testid="ribbon-user"]', { hasText: 'продолжай' })
    await expect(bubble).toBeVisible({ timeout: 30000 })
    await expect(bubble.locator('[data-testid="user-auto"] [data-testid="auto-tag"]')).toHaveCount(1)
  } finally {
    await app.close()
  }
})
