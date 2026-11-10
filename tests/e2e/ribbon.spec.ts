import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Drives the app against the fake SDK, which is handed its script through the
 * environment. Every run here is deterministic and never touches the real CLI.
 */
async function launch(script: unknown): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-ribbon-'))
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

test('ответ агента появляется по мере печати, а не целиком в конце', async () => {
  const { app, profile } = await launch({
    steps: [
      {
        kind: 'textStream',
        pieces: ['Начинаю ', 'разбираться ', 'с задачей'],
        pauseMs: 250
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    const text = win.locator('[data-testid="ribbon-agentText"]').first()

    // The first piece is on screen long before the last one arrives.
    await expect(text).toContainText('Начинаю', { timeout: 15000 })
    await expect(text).not.toContainText('с задачей')

    await expect(text).toContainText('Начинаю разбираться с задачей', { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('карточка инструмента свёрнута, по клику раскрывается', async () => {
  const { app, profile } = await launch({
    steps: [
      {
        kind: 'tool',
        name: 'Read',
        input: { file_path: 'C:/проект/auth.ts' },
        result: 'строка 1\nстрока 2\nстрока 3'
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="ribbon-tool"]').first()
    await expect(card).toBeVisible({ timeout: 15000 })

    await expect(card).toContainText('Чтение')
    await expect(card).toContainText('auth.ts')
    await expect(card).toContainText('3 строки')
    await expect(card.locator('[data-testid="tool-detail"]')).toBeHidden()

    await card.locator('[data-testid="tool-head"]').click()
    await expect(card.locator('[data-testid="tool-detail"]')).toContainText('строка 2')
  } finally {
    await close(app, profile)
  }
})

test('ошибка инструмента раскрыта сразу и помечена красным', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'toolError', name: 'Bash', input: { command: 'npm test' }, error: 'тесты упали: 3 из 40' }
    ]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="ribbon-toolError"]').first()

    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card).toContainText('тесты упали: 3 из 40')
    await expect(card.locator('.tool-card')).toHaveClass(/is-error/)
  } finally {
    await close(app, profile)
  }
})

test('размышления свёрнуты в строку с длительностью', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'thinking', text: 'взвешиваю варианты' }, { kind: 'text', text: 'готово' }]
  })
  try {
    const win = await app.firstWindow()
    const block = win.locator('[data-testid="ribbon-thinking"]').first()

    await expect(block).toBeVisible({ timeout: 15000 })
    await expect(block).toContainText('Думал')
    await expect(block.locator('[data-testid="thinking-text"]')).toBeHidden()

    await block.locator('[data-testid="thinking-head"]').click()
    await expect(block.locator('[data-testid="thinking-text"]')).toContainText('взвешиваю варианты')
  } finally {
    await close(app, profile)
  }
})

test('план — полоска «Задачи 1/3» над полем, лента не перекрыта', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'text', text: 'начинаю' },
      {
        kind: 'todo',
        items: [
          { content: 'разобрать ленту', status: 'completed', activeForm: 'разбираю ленту' },
          { content: 'собрать панель', status: 'in_progress', activeForm: 'собираю панель' },
          { content: 'проверить', status: 'pending', activeForm: 'проверяю' }
        ]
      },
      { kind: 'text', text: 'готово' }
    ]
  })
  try {
    const win = await app.firstWindow()
    const strip = win.locator('[data-testid="todo-strip"]')

    await expect(strip).toBeVisible({ timeout: 15000 })
    await expect(strip).toContainText('Задачи 1/3')
    await expect(strip).toContainText('собираю панель')
    await expect(win.locator('[data-testid="todo-panel"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="todo-list"]')).toHaveCount(0)

    // The list is rewritten whole; it must never pile up in the ribbon.
    await expect(win.locator('[data-testid="ribbon-tool"]')).toHaveCount(0)

    // The strip pins nothing over the conversation: the first row is not under it.
    const row = await win.locator('[data-testid^="ribbon-"]').first().boundingBox()
    const bar = await strip.boundingBox()
    expect(row).not.toBeNull()
    expect(bar).not.toBeNull()
    expect(row!.y).toBeLessThan(bar!.y)

    await strip.click()
    const list = win.locator('[data-testid="todo-list"]')
    await expect(list).toBeVisible()
    await expect(list.locator('[data-testid="todo-item"]')).toHaveCount(3)
  } finally {
    await close(app, profile)
  }
})

test('подагент сворачивает свои вызовы внутрь себя', async () => {
  const { app, profile } = await launch({
    steps: [
      {
        kind: 'subagent',
        name: 'найти утечку',
        steps: [
          { kind: 'tool', name: 'Grep', input: { pattern: 'leak' }, result: 'нашёл в три местах' }
        ]
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="ribbon-subagent"]').first()

    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card).toContainText('найти утечку')

    // Collapsed by default: the nested call is not loose in the ribbon, and
    // a closed card does not draw its steps at all.
    const nested = card.locator('[data-testid="ribbon-tool"]')
    await expect(win.locator('[data-testid="ribbon"] > [data-testid="ribbon-tool"]')).toHaveCount(0)
    await expect(nested).toHaveCount(0)

    await card.locator('[data-testid="subagent-head"]').click()
    await expect(nested).toBeVisible()
    await expect(nested).toContainText('Поиск')
  } finally {
    await close(app, profile)
  }
})

test('лента на 5000 элементов прокручивается без зависания', async () => {
  const steps = Array.from({ length: 2500 }, (_, i) => [
    { kind: 'text', text: `реплика ${i}` },
    { kind: 'tool', name: 'Read', input: { file_path: `файл-${i}.ts` }, result: 'ок' }
  ]).flat()

  const { app, profile } = await launch({ steps })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="ribbon"]')).toBeVisible({ timeout: 30000 })
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('реплика 2499', {
      timeout: 60000
    })

    // Virtualised: only what fits on screen is in the DOM.
    const rendered = await win.locator('[data-testid^="ribbon-"]').count()
    expect(rendered).toBeLessThan(200)

    const started = Date.now()
    await win.locator('[data-testid="ribbon"]').evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('реплика 0', {
      timeout: 10000
    })
    expect(Date.now() - started).toBeLessThan(10000)
  } finally {
    await close(app, profile)
  }
})

test('лента держится у низа, пока ты не прокрутил вверх сам', async () => {
  const steps = Array.from({ length: 200 }, (_, i) => ({
    kind: 'text' as const,
    text: `реплика ${i}`
  }))

  const { app, profile } = await launch({ steps, nextTurn: [{ kind: 'text', text: 'самый низ' }] })
  try {
    const win = await app.firstWindow()
    const ribbon = win.locator('[data-testid="ribbon"]')
    await expect(ribbon).toContainText('реплика 199', { timeout: 30000 })

    const atBottom = await ribbon.evaluate(
      (el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 4
    )
    expect(atBottom).toBe(true)

    // Scrolled up on purpose: new output must not yank the view back down.
    await ribbon.evaluate((el) => {
      el.scrollTop = 0
    })
    await win.waitForTimeout(300)
    const stayedPut = await ribbon.evaluate((el) => el.scrollTop < 50)
    expect(stayedPut).toBe(true)
  } finally {
    await close(app, profile)
  }
})

test('перезагрузка окна посреди потока: ни повторов, ни потерь', async () => {
  const total = 300
  const steps = Array.from({ length: total }, (_, i) => ({
    kind: 'textStream',
    pieces: [`часть ${i + 1} `, `конец ${i + 1}`],
    pauseMs: 10
  }))
  const { app, profile } = await launch({ steps })
  try {
    const win = await app.firstWindow()
    const texts = win.locator('[data-testid="ribbon-agentText"]')
    await expect(texts.first()).toContainText('конец 1', { timeout: 15000 })

    // Three times, while changes are still pouring in and some sit in the batch.
    for (let round = 0; round < 3; round++) {
      await win.reload()
      await expect(texts.first()).toBeVisible({ timeout: 15000 })
    }
    // Still streaming after the reloads, or the test proves nothing.
    await expect(win.getByText(`конец ${total}`)).toHaveCount(0)

    await expect(texts.last()).toContainText(`конец ${total}`, { timeout: 20000 })
    // Virtualised: walk the ribbon top to bottom. A doubled item sits next to
    // its twin, so it shows up twice in one screenful; the order of first
    // sightings is the ribbon's order.
    const { shown, doubled } = await win.locator('[data-testid="ribbon"]').evaluate(async (el) => {
      const seen: string[] = []
      const doubled: string[] = []
      const frame = (): Promise<void> =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
      for (let top = 0; ; top += Math.max(50, el.clientHeight / 2)) {
        el.scrollTop = top
        await frame()
        const here = [...el.querySelectorAll('[data-testid="ribbon-agentText"]')].map((node) =>
          (node as HTMLElement).innerText.trim()
        )
        for (const [i, text] of here.entries()) {
          if (here.indexOf(text) !== i) doubled.push(text)
          if (!seen.includes(text)) seen.push(text)
        }
        if (top >= el.scrollHeight) break
      }
      return { shown: seen, doubled }
    })
    expect(doubled).toEqual([])
    expect(shown).toEqual(
      Array.from({ length: total }, (_, i) => `часть ${i + 1} конец ${i + 1}`)
    )
  } finally {
    await close(app, profile)
  }
})
