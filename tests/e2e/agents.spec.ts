import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchQclod } from './helpers/launch'
import { resumedSession, writeTranscript } from '../fixtures/transcript.mjs'

/*
 * Stage 4 end to end on the fake SDK (task 17): the agents layer over a
 * pane's ribbon — the live graph, the timeline, a subagent's own ribbon,
 * writing to it through the main agent, stopping it, the task manager and
 * the graph of a past conversation.
 */

const read = (file: string) => ({ kind: 'tool', name: 'Read', input: { file_path: file }, result: 'ок' })

/** Two agents that are done and one that keeps working (it holds the turn). */
const THREE = [
  {
    kind: 'subagent',
    name: 'Обзор вставки',
    agentType: 'Explore',
    agentId: 'a0000000000000001',
    prompt: 'Найди, где падает вставка из буфера',
    model: 'claude-haiku-5-5',
    steps: [{ kind: 'text', text: 'Смотрю обработчик onPaste.' }, read('src/paste.ts')],
    stats: { totalTokens: 18000, totalDurationMs: 42000, totalToolUseCount: 7 },
    report: 'Вставка падает в onPaste: пустой clipboardData.'
  },
  {
    kind: 'subagent',
    name: 'Прогон тестов',
    agentId: 'a0000000000000002',
    steps: [{ kind: 'tool', name: 'Bash', input: { command: 'npm test' }, result: '12 passed' }],
    stats: { totalTokens: 9000, totalDurationMs: 21000, totalToolUseCount: 2 },
    report: 'Все тесты зелёные.'
  },
  {
    kind: 'subagent',
    name: 'Правка onPaste',
    agentId: 'a0000000000000003',
    steps: [read('src/paste.ts')],
    progress: [{ tokens: 4000, toolUses: 1, durationMs: 3000, lastTool: 'Read' }],
    holdMs: 60000
  }
]

const openAgents = (win: Page): Locator => win.locator('[data-testid="open-agents"]:visible')
const layer = (win: Page): Locator => win.locator('[data-testid="pane-layer"]:visible')
const nodes = (win: Page): Locator => layer(win).locator('[data-testid="agent-node"]')
const node = (win: Page, name: string): Locator => nodes(win).filter({ hasText: name })

/** The animation on a node's glow (::after): «agent-breathe» while it works, «none» otherwise. */
function glow(target: Locator): Promise<string> {
  return target.evaluate((el) => getComputedStyle(el, '::after').animationName)
}

test('кнопка «Агенты» открывает граф; три сабагента — три узла; работающий дышит, законченный нет', async () => {
  const { app, win } = await launchQclod({ script: { steps: THREE } })
  try {
    await expect(openAgents(win)).toHaveText('Агенты (1)', { timeout: 15000 })
    await openAgents(win).click()
    await expect(layer(win).locator('[data-testid="agent-graph"]')).toBeVisible()
    await expect(nodes(win)).toHaveCount(3)
    await expect(layer(win).locator('[data-testid="agents-count"]')).toHaveText('работают: 1 · всего: 3')

    const running = node(win, 'Правка onPaste')
    const done = node(win, 'Обзор вставки')
    await expect(running).toHaveAttribute('data-state', 'running')
    await expect(running).toContainText('работает')
    await expect(done).toHaveAttribute('data-state', 'done')
    await expect(done).toContainText('готов')
    expect(await glow(running)).toBe('agent-breathe')
    expect(await glow(done)).toBe('none')
    // The links to a working agent run; the rest stand still.
    await expect(layer(win).locator('.agent-edge.is-live')).toHaveCount(1)
    // What does not fit in the box is in its hint: tokens, the estimate, calls.
    await expect(done).toHaveAttribute('title', /18k токенов · (≈ \$|стоимость неизвестна).* · 7 вызовов/)

    // The pinned cards and the input stay in view under the layer.
    await expect(win.locator('[data-testid="composer-input"]:visible')).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(layer(win)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('переключатель «Таймлайн» показывает полосы; выбор вида переживает перезагрузку окна', async () => {
  const { app, win } = await launchQclod({ script: { steps: THREE } })
  try {
    await expect(openAgents(win)).toHaveText('Агенты (1)', { timeout: 15000 })
    await openAgents(win).click()
    await layer(win).locator('[data-testid="agents-view-timeline"]').click()
    const rows = layer(win).locator('[data-testid="agent-row"]')
    await expect(rows).toHaveCount(3)
    await expect(rows.filter({ hasText: 'Правка onPaste' })).toHaveAttribute('data-state', 'running')

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.reload())
    await win.waitForLoadState('domcontentloaded')
    await expect(openAgents(win)).toHaveText('Агенты (1)', { timeout: 15000 })
    await openAgents(win).click()
    await expect(layer(win).locator('[data-testid="agents-view-timeline"]')).toHaveAttribute('aria-selected', 'true')
    await expect(layer(win).locator('[data-testid="agent-row"]')).toHaveCount(3)
  } finally {
    await app.close()
  }
})

test('клик по узлу открывает ленту сабагента с его текстом и задачей; «← Все агенты» возвращает', async () => {
  const { app, win } = await launchQclod({ script: { steps: THREE } })
  try {
    await expect(openAgents(win)).toHaveText('Агенты (1)', { timeout: 15000 })
    await openAgents(win).click()
    await node(win, 'Обзор вставки').click()

    const view = layer(win).locator('[data-testid="agent-view"]')
    await expect(view).toBeVisible()
    await expect(view).toContainText('Explore')
    await expect(view).toContainText('Обзор вставки')
    await expect(view).toContainText('Смотрю обработчик onPaste.')
    await expect(view).toContainText('claude-haiku-5-5')
    // Only its own: the neighbour's words are not here.
    await expect(view).not.toContainText('npm test')
    // What the main agent asked of it, folded under the head.
    await view.locator('.agent-prompt summary').click()
    await expect(view.locator('.agent-prompt')).toContainText('Найди, где падает вставка из буфера')
    // Its own input stands where the chat's did.
    await expect(win.locator('[data-testid="agent-composer-input"]:visible')).toBeVisible()
    await expect(win.locator('[data-testid="composer-input"]:visible')).toHaveCount(0)

    await view.getByRole('button', { name: 'Назад ко всем агентам' }).click()
    await expect(layer(win).locator('[data-testid="agent-graph"]')).toBeVisible()
    await expect(win.locator('[data-testid="composer-input"]:visible')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('написать законченному агенту: «передано», узел снова работает, «запуск 2»', async () => {
  const { app, win } = await launchQclod({
    script: {
      steps: [THREE[0]],
      resumeHoldMs: 4000,
      nextTurn: [{ kind: 'text', text: 'Передал агенту.' }]
    }
  })
  try {
    await expect(openAgents(win)).toBeVisible({ timeout: 15000 })
    await expect(win.locator('[data-testid="ribbon-subagent"]')).toContainText('готов', { timeout: 15000 })
    await openAgents(win).click()
    await node(win, 'Обзор вставки').click()
    const view = layer(win).locator('[data-testid="agent-view"]')
    await expect(view).toBeVisible()

    const input = win.locator('[data-testid="agent-composer-input"]:visible')
    await input.fill('Добавь ещё одно предложение о тестах')
    await win.locator('[data-testid="agent-composer-send"]:visible').click()

    const message = view.locator('[data-testid="agent-message"]').filter({ hasText: 'Добавь ещё одно предложение о тестах' })
    await expect(message).toHaveAttribute('data-state', 'passed', { timeout: 15000 })
    await expect(message).toContainText('передано')
    await expect(view.locator('.agent-view-state')).toContainText('работает', { timeout: 10000 })
    await expect(view).toContainText('запуск 2')
    // Its new words land in the same ribbon, then it is done again.
    await expect(view).toContainText('продолжил: Добавь ещё одно предложение о тестах', { timeout: 15000 })
    await expect(view.locator('.agent-view-state')).toContainText('готов', { timeout: 15000 })

    // The main ribbon has the person's bubble «→ агенту …» and one graph node still.
    await view.getByRole('button', { name: 'Назад ко всем агентам' }).click()
    await expect(nodes(win)).toHaveCount(1)
    await expect(node(win, 'Обзор вставки')).toContainText('запуск 2')
    await win.keyboard.press('Escape')
    const bubble = win.locator('[data-testid="ribbon-user"]').filter({ hasText: 'Добавь ещё одно предложение о тестах' })
    await expect(bubble).toContainText('агенту Explore:')
    await expect(win.locator('[data-testid="ribbon"]:visible')).not.toContainText('Передай агенту')
  } finally {
    await app.close()
  }
})

test('«Остановить» у работающего агента: состояние «остановлен»', async () => {
  const { app, win } = await launchQclod({ script: { steps: [THREE[2], { kind: 'text', text: 'Ход главного дошёл до конца.' }] } })
  try {
    await expect(openAgents(win)).toHaveText('Агенты (1)', { timeout: 15000 })
    await openAgents(win).click()
    await node(win, 'Правка onPaste').click()
    const view = layer(win).locator('[data-testid="agent-view"]')
    await view.locator('[data-testid="agent-stop"]').click()
    await expect(view.locator('.agent-view-state')).toContainText('остановлен', { timeout: 10000 })
    await expect(view.locator('[data-testid="agent-stop"]')).toHaveCount(0)
    await expect(view.locator('[data-testid="agent-stop-error"]')).toHaveCount(0)

    await view.getByRole('button', { name: 'Назад ко всем агентам' }).click()
    await expect(node(win, 'Правка onPaste')).toHaveAttribute('data-state', 'stopped')
    await win.keyboard.press('Escape')
    // Moved to the background first, the main agent's turn went on.
    await expect(win.locator('[data-testid="ribbon"]:visible')).toContainText('Ход главного дошёл до конца.', { timeout: 10000 })
    await expect(win.locator('[data-testid="ribbon"]:visible')).not.toContainText('не остановился')
  } finally {
    await app.close()
  }
})

test('прошлый разговор с подагентом Explore (фикстура resumedSession) — узел в графе и строка в таймлайне', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'qclod-config-'))
  const sessionId = '0f0e0d0c-0b0a-4908-8706-050403020100'
  const session = resumedSession(sessionId, process.cwd())
  writeTranscript(configDir, process.cwd(), sessionId, session.lines, session.subagents)
  const DAY = 24 * 60 * 60 * 1000
  const { app, win } = await launchQclod({
    script: { steps: [] },
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      QCLOD_FAKE_HISTORY: JSON.stringify({
        sessions: [
          { sessionId, summary: 'Почему падает вставка', lastModified: Date.now() - DAY, firstPrompt: 'найди, где падает вставка' }
        ]
      })
    }
  })
  try {
    await win.locator('[data-testid="sidebar-session"]').first().click()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })
    await expect(win.locator('[data-testid="ribbon"]:visible')).toContainText('смотрю', { timeout: 15000 })

    await openAgents(win).click()
    const explore = node(win, 'Explore')
    await expect(explore).toHaveCount(1)
    await expect(explore).toContainText('Обзор вставки')
    await expect(explore).toContainText('готов')

    await layer(win).locator('[data-testid="agents-view-timeline"]').click()
    const row = layer(win).locator('[data-testid="agent-row"]').filter({ hasText: 'Обзор вставки' })
    await expect(row).toHaveCount(1)
    // The transcript's line times place it on the scale: a bar of its own length.
    const bar = await row.locator('.agent-bar').boundingBox()
    expect(bar!.width).toBeGreaterThan(2)
  } finally {
    await app.close()
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('emulateMedia reducedMotion: reduce — у узла animation-name none', async () => {
  const { app, win } = await launchQclod({ script: { steps: THREE } })
  try {
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await expect(openAgents(win)).toHaveText('Агенты (1)', { timeout: 15000 })
    await openAgents(win).click()
    const running = node(win, 'Правка onPaste')
    await expect(running).toHaveAttribute('data-state', 'running')
    expect(await glow(running)).toBe('none')
    const edge = layer(win).locator('.agent-edge.is-live')
    expect(await edge.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    // The meaning is still there in words.
    await expect(running).toContainText('работает')
  } finally {
    await app.close()
  }
})

test('диспетчер задач: фоновый агент и фоновая команда в одном списке, «Открыть ленту» открывает слой на этом агенте', async () => {
  const { app, win } = await launchQclod({
    script: {
      steps: [],
      nextTurn: [
        {
          kind: 'backgroundAgent',
          name: 'Обзор модулей',
          agentType: 'Explore',
          agentId: 'a00000000000000bg',
          progress: [{ summary: 'Читает модуль вставки', tokens: 1200, toolUses: 1, durationMs: 2000 }],
          pauseMs: 200,
          finish: null
        },
        { kind: 'backgroundBash', command: 'npm run dev', chunks: ['готово\n'], pauseMs: 300, finish: null },
        { kind: 'text', text: 'Запустил в фоне.' }
      ]
    }
  })
  try {
    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await input.fill('запусти обзор и сервер')
    await input.press('Enter')

    const counter = win.locator('[data-testid="status-bg"]')
    await expect(counter).toHaveText('Фоновые 2', { timeout: 15000 })
    await counter.click()
    const list = win.locator('[data-testid="bg-list"]')
    const agentRow = list.locator('[data-testid="bg-task"][data-kind="agent"]')
    const commandRow = list.locator('[data-testid="bg-task"][data-kind="command"]')
    await expect(agentRow).toHaveCount(1)
    await expect(commandRow).toHaveCount(1)
    await expect(agentRow).toContainText('Explore')
    await expect(agentRow).toContainText('Обзор модулей')
    await expect(agentRow).toContainText('Читает модуль вставки', { timeout: 10000 })
    await expect(commandRow).toContainText('npm run dev')

    await agentRow.locator('[data-testid="bg-open-agent"]').click()
    await expect(list).toHaveCount(0)
    const view = layer(win).locator('[data-testid="agent-view"]')
    await expect(view).toBeVisible()
    await expect(view).toContainText('Обзор модулей')
    await expect(view).toContainText('фон')
  } finally {
    await app.close()
  }
})
