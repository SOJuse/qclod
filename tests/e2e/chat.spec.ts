import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Tool cards against the fake SDK: what a folded card says at a glance and
 * what an opened one shows. Structured outputs follow sdk-tools.d.ts.
 */
async function launch(script: unknown): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-chat-'))
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

const STEPS = [
  {
    kind: 'tool',
    name: 'Read',
    input: { file_path: 'C:/проект/auth.ts' },
    result: 'строка 1\nстрока 2',
    output: {
      type: 'text',
      file: { filePath: 'C:/проект/auth.ts', content: 'строка 1\nстрока 2', numLines: 2, startLine: 1, totalLines: 2 }
    }
  },
  {
    kind: 'tool',
    name: 'Grep',
    input: { pattern: 'login', path: 'src' },
    result: 'src/a.ts\nsrc/b.ts',
    output: { mode: 'files_with_matches', numFiles: 2, filenames: ['src/a.ts', 'src/b.ts'] }
  },
  {
    kind: 'tool',
    name: 'Edit',
    input: { file_path: 'C:/проект/a.ts', old_string: 'b', new_string: 'c\nd' },
    result: 'The file has been updated.',
    output: {
      filePath: 'C:/проект/a.ts',
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }]
    }
  },
  {
    kind: 'tool',
    name: 'Bash',
    input: { command: 'npm test', description: 'Run tests' },
    result: 'ok',
    output: { stdout: 'ok', stderr: 'warn', interrupted: false }
  },
  {
    kind: 'tool',
    name: 'mcp__gh__x',
    input: { title: 'Баг', labels: ['a'] },
    result: 'создано'
  }
]

function card(win: Page, category: string) {
  return win.locator(`.tool-card[data-category="${category}"]`).first()
}

test('у карточек разных категорий свои значок и цвет', async () => {
  const { app, profile } = await launch({ steps: STEPS })
  try {
    const win = await app.firstWindow()
    for (const category of ['read', 'search', 'edit', 'command', 'mcp']) {
      const c = card(win, category)
      await expect(c).toBeVisible({ timeout: 15000 })
      await expect(c.locator('[data-testid="tool-head"] svg').first()).toBeVisible()
    }
    await expect(card(win, 'read')).toContainText('Чтение')
    await expect(card(win, 'command')).toContainText('Команда')
    await expect(card(win, 'mcp')).toContainText('gh · x')

    const rule = (category: string): Promise<string> =>
      card(win, category).evaluate((el) => getComputedStyle(el).borderLeftColor)
    expect(await rule('edit')).not.toBe(await rule('command'))
  } finally {
    await close(app, profile)
  }
})

test('свёрнутая правка показывает +N −M', async () => {
  const { app, profile } = await launch({ steps: STEPS })
  try {
    const win = await app.firstWindow()
    await expect(card(win, 'edit').locator('[data-testid="tool-head"]')).toContainText('+2 −1', { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('раскрытая команда: команда, stdout и stderr раздельно', async () => {
  const { app, profile } = await launch({ steps: STEPS })
  try {
    const win = await app.firstWindow()
    const c = card(win, 'command')
    await expect(c).toBeVisible({ timeout: 15000 })
    await expect(c.locator('[data-testid="tool-stdout"]')).toBeHidden()

    await c.locator('[data-testid="tool-head"]').click()
    await expect(c.locator('[data-testid="tool-stdout"]')).toHaveText(/^\s*ok\s*$/)
    await expect(c.locator('[data-testid="tool-stderr"]')).toHaveText(/^\s*warn\s*$/)
    await expect(c.locator('[data-testid="tool-detail"]')).toContainText('npm test')
    // The tab's folder: where the command ran.
    await expect(c.locator('[data-testid="tool-cwd"]')).toHaveText(/\S/)
  } finally {
    await close(app, profile)
  }
})

test('раскрытая правка показывает дифф построчно', async () => {
  const { app, profile } = await launch({ steps: STEPS })
  try {
    const win = await app.firstWindow()
    const c = card(win, 'edit')
    await expect(c).toBeVisible({ timeout: 15000 })
    await c.locator('[data-testid="tool-head"]').click()
    await expect(c.locator('.diff-line.is-add')).toHaveCount(2)
    await expect(c.locator('.diff-line.is-del')).toHaveCount(1)
    await expect(c.locator('.diff-line.is-del')).toContainText('b')
  } finally {
    await close(app, profile)
  }
})

test('MCP раскрывается таблицей аргументов', async () => {
  const { app, profile } = await launch({ steps: STEPS })
  try {
    const win = await app.firstWindow()
    const c = card(win, 'mcp')
    await expect(c).toBeVisible({ timeout: 15000 })
    await c.locator('[data-testid="tool-head"]').click()
    const args = c.locator('[data-testid="tool-args"]')
    await expect(args).toContainText('title')
    await expect(args).toContainText('Баг')
    await expect(args).toContainText('["a"]')
    await expect(c.locator('[data-testid="tool-detail"]')).toContainText('создано')
  } finally {
    await close(app, profile)
  }
})

test('внизу любой карточки — сырые вход и выход', async () => {
  const { app, profile } = await launch({ steps: STEPS })
  try {
    const win = await app.firstWindow()
    for (const category of ['read', 'search', 'edit', 'command', 'mcp']) {
      const c = card(win, category)
      await expect(c).toBeVisible({ timeout: 15000 })
      await c.locator('[data-testid="tool-head"]').click()
      const raw = c.locator('[data-testid="tool-raw"]')
      await expect(raw).toContainText('Вход и выход как есть')
      await raw.locator('summary').click()
      await expect(raw).toContainText('"input"')
    }
    await expect(card(win, 'command').locator('[data-testid="tool-raw"]')).toContainText('"stderr": "warn"')
  } finally {
    await close(app, profile)
  }
})

test('ошибка раскрыта сразу, текст ошибки сверху, категория та же', async () => {
  const { app, profile } = await launch({
    steps: [
      { kind: 'tool', name: 'Bash', input: { command: 'ls' }, result: 'ok', output: { stdout: 'a', stderr: '', interrupted: false } },
      { kind: 'toolError', name: 'Bash', input: { command: 'npm test', description: 'Run tests' }, error: 'тесты упали: 3 из 40' }
    ]
  })
  try {
    const win = await app.firstWindow()
    const c = win.locator('.tool-card.is-error[data-category="command"]').first()
    await expect(c).toBeVisible({ timeout: 15000 })
    await expect(c.locator('[data-testid="tool-error"]')).toContainText('тесты упали: 3 из 40')
    const body = c.locator('[data-testid="tool-detail"]')
    // The failed command reads like any command: what ran, why, where.
    await expect(body).toContainText('Команда')
    await expect(body).toContainText('npm test')
    await expect(body).toContainText('Зачем')
    await expect(c.locator('[data-testid="tool-cwd"]')).toHaveText(/\S/)
    await expect(c.locator('[data-testid="tool-args"]')).toHaveCount(0)
    await expect(body).not.toContainText('command')
    // The error is said once, on top, not again as a stderr block.
    await expect(c.locator('[data-testid="tool-stderr"]')).toHaveCount(0)

    // The icon sits in a chip tinted by the card's state.
    const chip = (el: ReturnType<typeof card>): Promise<string> =>
      el.locator('.tool-chip').evaluate((n) => getComputedStyle(n).backgroundColor)
    const ok = win.locator('.tool-card.is-done[data-category="command"]').first()
    const okChip = await chip(ok)
    expect(okChip).not.toBe('rgba(0, 0, 0, 0)')
    expect(await chip(c)).not.toBe(okChip)
  } finally {
    await close(app, profile)
  }
})

test('мысли, что шли время, — «Думал N с»', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'thinking', text: 'взвешиваю', ms: 1200 }, { kind: 'text', text: 'готово' }]
  })
  try {
    const win = await app.firstWindow()
    const head = win.locator('[data-testid="ribbon-thinking"] [data-testid="thinking-head"]').first()
    await expect(head).toHaveText(/Думал (1|2),\d с/, { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('мысли свёрнуты строкой «Думал»', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'thinking', text: 'взвешиваю варианты' }, { kind: 'text', text: 'готово' }]
  })
  try {
    const win = await app.firstWindow()
    const block = win.locator('[data-testid="ribbon-thinking"]').first()
    const head = block.locator('[data-testid="thinking-head"]')
    await expect(head).toContainText('Думал', { timeout: 15000 })
    // A whole thinking block arrives at once and has no length to print.
    await expect(head).not.toContainText('0,0')
    await expect(head.locator('svg')).toBeVisible()
    await expect(block.locator('[data-testid="thinking-text"]')).toBeHidden()

    await head.click()
    await expect(block.locator('[data-testid="thinking-text"]')).toContainText('взвешиваю варианты')
  } finally {
    await close(app, profile)
  }
})

test('длинный вывод прокручивается, «Показать всё» снимает предел', async () => {
  const stdout = Array.from({ length: 120 }, (_, i) => `строка ${i + 1}`).join('\n')
  const { app, profile } = await launch({
    steps: [
      { kind: 'tool', name: 'Bash', input: { command: 'seq 120' }, result: 'ok', output: { stdout, stderr: '', interrupted: false } }
    ]
  })
  try {
    const win = await app.firstWindow()
    const c = card(win, 'command')
    await expect(c).toBeVisible({ timeout: 15000 })
    await c.locator('[data-testid="tool-head"]').click()
    const out = c.locator('[data-testid="tool-stdout"]')
    await expect(out).toContainText('строка 120')
    expect(await out.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(320)

    await c.getByRole('button', { name: 'Показать всё' }).click()
    await expect.poll(() => out.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
  } finally {
    await close(app, profile)
  }
})

test('свёрнутый поиск: сначала что ищут, потом где', async () => {
  const { app, profile } = await launch({ steps: STEPS })
  try {
    const win = await app.firstWindow()
    const target = card(win, 'search').locator('.tool-target')
    await expect(target).toHaveText(/login.*src/, { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('аргументы прочих инструментов подписаны по-русски, неизвестные — как есть моноширинно', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'tool', name: 'ToolSearch', input: { query: 'notebook', max_results: 5 }, result: 'нашлось' }]
  })
  try {
    const win = await app.firstWindow()
    const c = card(win, 'search')
    await expect(c).toBeVisible({ timeout: 15000 })
    await c.locator('[data-testid="tool-head"]').click()
    const args = c.locator('[data-testid="tool-args"]')
    await expect(args.locator('th').first()).toHaveText('Запрос')
    const unknown = args.locator('th', { hasText: 'max_results' })
    await expect(unknown).toHaveClass(/tool-mono/)
    await expect(args).not.toContainText('query')
  } finally {
    await close(app, profile)
  }
})

test('большой дифф показывает 400 строк и «ещё N строк», служебная строка без номера', async () => {
  const lines = [' a', ...Array.from({ length: 450 }, (_, i) => `+n${i}`), '\\ No newline at end of file']
  const { app, profile } = await launch({
    steps: [
      {
        kind: 'tool',
        name: 'Edit',
        input: { file_path: 'C:/проект/big.ts' },
        result: 'ok',
        output: { filePath: 'C:/проект/big.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 451, lines }] }
      },
      {
        kind: 'tool',
        name: 'Edit',
        input: { file_path: 'C:/проект/nl.ts' },
        result: 'ok',
        output: { filePath: 'C:/проект/nl.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+b'] }] }
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    const big = win.locator('.tool-card[data-category="edit"]').first()
    await expect(big).toBeVisible({ timeout: 15000 })
    await big.locator('[data-testid="tool-head"]').click()
    await expect(big.locator('.diff-line')).toHaveCount(400)
    await expect(big.locator('[data-testid="tool-diff"]')).toContainText('ещё 51 строка')

    const nl = win.locator('.tool-card[data-category="edit"]').nth(1)
    await nl.locator('[data-testid="tool-head"]').click()
    await expect(nl.locator('.diff-line')).toHaveCount(2)
    // «+b» is new line 1: the note line takes no number.
    await expect(nl.locator('.diff-line.is-add .diff-no').nth(1)).toHaveText('1')
  } finally {
    await close(app, profile)
  }
})

test('подагент раскрывается в свою ленту шагов и отчёт внизу', async () => {
  const { app, profile } = await launch({
    steps: [
      {
        kind: 'subagent',
        name: 'найти вход',
        agentType: 'Explore',
        stats: { totalTokens: 4000, totalDurationMs: 12000, totalToolUseCount: 2 },
        report: 'Нашёл два места:\n- src/a.ts\n- src/b.ts',
        steps: [STEPS[0], STEPS[1], { kind: 'text', text: 'просмотрел оба файла' }]
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="ribbon-subagent"]').first()
    await expect(card).toBeVisible({ timeout: 15000 })

    const head = card.locator('[data-testid="subagent-head"]')
    await expect(head).toContainText('Explore')
    await expect(head).toContainText('найти вход')
    await expect(head).toContainText('готов')
    await expect(head).not.toContainText('готово')
    await expect(head).toContainText('12 с')
    // Folded and finished, the head says in one line what came of it.
    const summary = head.locator('[data-testid="subagent-summary"]')
    await expect(summary).toHaveText('Нашёл два места:')
    await expect(summary).toHaveAttribute('title', 'Нашёл два места:')
    // Tool calls are steps; the subagent's own words are not counted.
    await expect(card.locator('[data-testid="subagent-step-count"]')).toHaveText('2 шага')

    // Its steps never leak into the main ribbon as rows of their own.
    await expect(win.locator('[data-testid="ribbon"] > [data-testid="ribbon-tool"]')).toHaveCount(0)
    await expect(card.locator('[data-testid="subagent-steps"]')).toHaveCount(0)

    await head.click()
    const steps = card.locator('[data-testid="subagent-steps"]')
    await expect(steps).toBeVisible()
    const tools = steps.locator('.tool-card')
    await expect(tools).toHaveCount(2)
    await expect(tools.nth(0)).toHaveAttribute('data-category', 'read')
    await expect(tools.nth(1)).toHaveAttribute('data-category', 'search')
    await expect(tools.nth(0)).toHaveClass(/is-compact/)
    await expect(steps).toContainText('просмотрел оба файла')

    // The report sits below the steps, as Markdown: its line breaks survive.
    const report = card.locator('[data-testid="subagent-report"]')
    await expect(report).toContainText('Нашёл два места')
    await expect(report.locator('.subagent-report-title')).toHaveText('Отчёт')
    // Opened, the report itself is below; the head no longer repeats it.
    await expect(summary).toHaveCount(0)
    await expect(report.locator('li')).toHaveCount(2)
    const order = await card.evaluate((el) => {
      const s = el.querySelector('[data-testid="subagent-steps"]')!
      const r = el.querySelector('[data-testid="subagent-report"]')!
      return s.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING
    })
    expect(order).toBeTruthy()

    // Folding it again takes the steps out of the page.
    await head.click()
    await expect(card.locator('[data-testid="subagent-steps"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('вложенный подагент показан внутри родителя', async () => {
  const { app, profile } = await launch({
    steps: [
      {
        kind: 'subagent',
        name: 'обзор модуля',
        agentType: 'Explore',
        steps: [
          { kind: 'tool', name: 'Glob', input: { pattern: '*.ts' }, result: 'a.ts' },
          {
            kind: 'subagent',
            name: 'разобрать a.ts',
            agentType: 'Plan',
            report: 'внутренний отчёт',
            steps: [STEPS[0]]
          }
        ]
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    const ribbon = win.locator('[data-testid="ribbon"]')
    const outer = ribbon.locator(':scope > [data-testid="ribbon-subagent"]')
    await expect(outer).toHaveCount(1, { timeout: 15000 })
    await expect(outer.locator(':scope > * > [data-testid="subagent-head"]')).toContainText('обзор модуля')
    await expect(outer.locator(':scope > * > [data-testid="subagent-head"] [data-testid="subagent-step-count"]')).toHaveText(
      '2 шага'
    )

    await outer.locator('[data-testid="subagent-head"]').first().click()
    const outerSteps = outer.locator('[data-testid="subagent-steps"]').first()
    const inner = outerSteps.locator('[data-testid="ribbon-subagent"]')
    await expect(inner).toHaveCount(1)
    await expect(inner).toContainText('Plan')
    await expect(inner).toContainText('разобрать a.ts')
    // The inner agent's own call is inside it, not beside it in the parent.
    await expect(outerSteps.locator(':scope > [data-testid="ribbon-tool"]')).toHaveCount(1)
    await expect(outerSteps.locator(':scope > [data-testid="ribbon-tool"]')).toContainText('*.ts')
    await expect(outerSteps).not.toContainText('auth.ts')

    await inner.locator('[data-testid="subagent-head"]').click()
    await expect(inner.locator('[data-testid="subagent-steps"] .tool-card')).toHaveCount(1)
    await expect(inner.locator('[data-testid="subagent-steps"]')).toContainText('auth.ts')
    await expect(inner.locator('[data-testid="subagent-report"]')).toContainText('внутренний отчёт')
  } finally {
    await close(app, profile)
  }
})

test('у подагента с десятками шагов видны последние, остальные — по «ещё N шагов»', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    kind: 'tool',
    name: 'Read',
    input: { file_path: `C:/проект/f${i}.ts` },
    result: 'ок'
  }))
  // Thoughts are not drawn in a card, so they take no place in its window.
  const thoughts = Array.from({ length: 5 }, (_, i) => ({ kind: 'thinking', text: `мысль ${i}` }))
  const { app, profile } = await launch({
    steps: [{ kind: 'subagent', name: 'перебор', steps: [...thoughts, ...many] }]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="ribbon-subagent"]').first()
    await expect(card.locator('[data-testid="subagent-step-count"]')).toHaveText('60 шагов', { timeout: 15000 })

    await card.locator('[data-testid="subagent-head"]').click()
    const steps = card.locator('[data-testid="subagent-steps"]')
    await expect(steps.locator('.tool-card')).toHaveCount(50)
    // The newest steps are the ones shown; the earliest wait behind the button.
    await expect(steps).toContainText('f59.ts')
    await expect(steps).not.toContainText('f9.ts')
    const more = steps.locator('[data-testid="subagent-more"]')
    await expect(more).toHaveText('ещё 10 шагов')
    await more.click()
    await expect(steps.locator('.tool-card')).toHaveCount(60)
    await expect(more).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('работающий подагент показывает в шапке, что делает сейчас', async () => {
  const { app, profile } = await launch({
    steps: [
      {
        kind: 'backgroundAgent',
        name: 'прогнать тесты',
        agentType: 'builder',
        progress: [{ tokens: 1200, toolUses: 1, durationMs: 15000, lastTool: 'Bash' }],
        finish: null
      }
    ]
  })
  try {
    const win = await app.firstWindow()
    const head = win.locator('[data-testid="subagent-head"]').first()
    await expect(head).toContainText('работает', { timeout: 15000 })
    await expect(head).toContainText('· Bash')
    await expect(head.locator('[data-testid="subagent-stats"]')).toContainText('15 с')
  } finally {
    await close(app, profile)
  }
})

test('если за кнопкой не только шаги, она считает записи', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    kind: 'tool',
    name: 'Read',
    input: { file_path: `C:/проект/f${i}.ts` },
    result: 'ок'
  }))
  const { app, profile } = await launch({
    steps: [{ kind: 'subagent', name: 'перебор', steps: [{ kind: 'text', text: 'начинаю' }, ...many] }]
  })
  try {
    const win = await app.firstWindow()
    const card = win.locator('[data-testid="ribbon-subagent"]').first()
    await card.locator('[data-testid="subagent-head"]').click({ timeout: 15000 })
    const steps = card.locator('[data-testid="subagent-steps"]')
    await expect(steps.locator('.tool-card')).toHaveCount(50)
    // Hidden: ten calls and one line of text.
    await expect(steps.locator('[data-testid="subagent-more"]')).toHaveText('ещё 11 записей')
  } finally {
    await close(app, profile)
  }
})

test('пока идёт команда, строка «сейчас» говорит «Запускает npm test»', async () => {
  const { app, profile } = await launch({
    steps: [{ kind: 'text', text: 'слушаю' }],
    nextTurn: [
      { kind: 'tool', name: 'Bash', input: { command: 'npm test' }, result: 'ok', pauseMs: 1500 },
      { kind: 'text', text: 'готово' }
    ]
  })
  try {
    const win = await app.firstWindow()
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('слушаю', { timeout: 15000 })
    await expect(win.locator('[data-testid="now-line"]')).toHaveCount(0)

    await input.click()
    await input.fill('прогони тесты')
    await input.press('Enter')

    const line = win.locator('[data-testid="now-line"]')
    await expect(line.locator('[data-testid="now-what"]')).toHaveText('Запускает', { timeout: 15000 })
    await expect(line.locator('[data-testid="now-object"]')).toHaveText('npm test')
    await expect(line).toHaveAttribute('data-category', 'command')
    await expect(line.locator('[data-testid="now-time"]')).toHaveText(/^\d+:\d\d$/)
    await expect(line).toHaveCount(0, { timeout: 15000 })
  } finally {
    await close(app, profile)
  }
})

test('два фоновых подагента — «2 агента», клик раскрывает список', async () => {
  const agent = (name: string, agentType: string, lastTool: string) => ({
    kind: 'backgroundAgent',
    name,
    agentType,
    pauseMs: 200,
    progress: [{ tokens: 500, toolUses: 1, durationMs: 3000, lastTool }],
    finish: null
  })
  const { app, profile } = await launch({
    steps: [agent('прогнать тесты', 'builder', 'Bash'), agent('найти вызовы', 'Explore', 'Grep')]
  })
  try {
    const win = await app.firstWindow()
    const line = win.locator('[data-testid="now-line"]')
    const button = line.locator('[data-testid="now-agents"]')
    await expect(button).toHaveText('2 агента', { timeout: 15000 })
    // The turn is over: the agents keep going, the turn's clock does not.
    await expect(line.locator('[data-testid="now-time"]')).toHaveCount(0)
    await expect(line.locator('[data-testid="now-background"]')).toHaveText('Работают в фоне')
    await expect(line.locator('[data-testid="now-agents-list"]')).toHaveCount(0)

    await button.click()
    const list = line.locator('[data-testid="now-agents-list"]')
    await expect(list.locator('li')).toHaveCount(2)
    await expect(list).toContainText('прогнать тесты')
    await expect(list).toContainText('builder')
    await expect(list.locator('li').first()).toContainText('Bash', { timeout: 10000 })
    await expect(list).toContainText('найти вызовы')

    await button.click()
    await expect(list).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('новая вкладка без входа: Войти, и вкладка продолжает', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-chat-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_AUTH: JSON.stringify({ sequence: ['in'], pollMs: 50 }),
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({
        steps: [],
        nextTurn: [
          // The first session dies before it introduces itself, as an agent
          // that is not logged in does; the one started after login answers.
          { kind: 'crash', message: 'Not logged in · Please run /login', times: 1, beforeInit: true },
          { kind: 'text', text: 'ответ после входа' }
        ]
      })
    } as Record<string, string>
  })
  try {
    const win = await app.firstWindow()
    const ribbon = win.locator('[data-testid="ribbon"]')
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })

    await input.click()
    await input.fill('сделай отчёт')
    await input.press('Enter')

    const login = win.locator('[data-testid="notice-login"]')
    await expect(login).toBeVisible({ timeout: 15000 })
    await expect(ribbon).toContainText('Нажмите «Войти» — после входа вкладка продолжит сама.')
    await expect(ribbon).not.toContainText('Not logged in')

    await login.click()
    await expect(ribbon).toContainText('ответ после входа', { timeout: 15000 })
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as { __qclodLoginOpens?: string[] }).__qclodLoginOpens?.length ?? 0)
      )
      .toBe(1)

    // The resend draws no second bubble (its echo matches the first), so the
    // bubble count only shows nothing was sent anew. The answer count is what
    // shows the message reached the new session once: every send the fake
    // gets plays a turn and says this text. The driver-level «sent exactly
    // once» is checked in tabController.test.ts.
    const users = win.locator('[data-testid="ribbon-user"]')
    const answers = win.locator('[data-testid="ribbon-agentText"]').filter({ hasText: 'ответ после входа' })
    await expect(users).toHaveCount(1)
    await expect(answers).toHaveCount(1)
    // A second, unwanted resend would show within this time.
    await win.waitForTimeout(1000)
    await expect(users).toHaveCount(1)
    await expect(answers).toHaveCount(1)
  } finally {
    await close(app, profile)
  }
})
