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
