import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditContrast } from './helpers/contrast'
import { expectFocusRing, launchQclod } from './helpers/launch'
import { shot } from './helpers/shot'

const DAY = 24 * 60 * 60 * 1000
const THREE_SESSIONS = {
  sessions: [
    { sessionId: 'с-1', summary: 'Починка вставки файлов', lastModified: Date.now() - 2 * 60 * 60 * 1000, firstPrompt: 'вставка файлов не работает' },
    { sessionId: 'с-2', summary: 'Переезд на SDK', lastModified: Date.now() - DAY, firstPrompt: 'давай перепишем ядро' },
    { sessionId: 'с-3', summary: 'Тёмная тема', lastModified: Date.now() - 6 * DAY, firstPrompt: 'цвета унылые' }
  ]
}
const HISTORY_ENV = { QCLOD_FAKE_HISTORY: JSON.stringify(THREE_SESSIONS) }

/** One card of every category, then the user opens the command and the edit. */
const ALL_CATEGORIES = [
  { kind: 'text', text: 'Смотрю, как устроен вход.' },
  { kind: 'tool', name: 'Read', input: { file_path: 'C:/проект/auth.ts' }, result: 'строка 1\nстрока 2' },
  { kind: 'tool', name: 'Grep', input: { pattern: 'login', path: 'src' }, result: 'src/a.ts\nsrc/b.ts' },
  { kind: 'tool', name: 'Edit', input: { file_path: 'C:/проект/a.ts', old_string: 'b', new_string: 'c\nd' }, result: 'The file has been updated.' },
  { kind: 'tool', name: 'Bash', input: { command: 'npm test', description: 'Run tests' }, result: 'ok\n2 passed' },
  { kind: 'tool', name: 'mcp__gh__x', input: { title: 'Баг', labels: ['a'] }, result: 'создано' },
  { kind: 'tool', name: 'EnterPlanMode', input: {}, result: 'ok' },
  { kind: 'tool', name: 'Skill', input: { skill: 'review' }, result: 'ok' },
  { kind: 'subagent', name: 'найти утечку', steps: [{ kind: 'tool', name: 'Grep', input: { pattern: 'leak' }, result: 'нашёл' }] },
  { kind: 'text', text: 'Готово. Правил `src/a.ts:3`.' }
]

async function send(win: Page, text: string): Promise<void> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

/** A profile whose agent path names a file that is not there: how a machine without Claude Code looks. */
function missingAgentProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-screens-'))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ agentPath: join(profile, 'нет', 'claude.exe') }), 'utf8')
  return profile
}

interface Screen {
  name: string
  env?: () => Record<string, string>
  script?: unknown
  open: (win: Page) => Promise<void>
}

const SCREENS: Screen[] = [
  {
    name: 'пустая вкладка',
    env: () => HISTORY_ENV,
    open: async (win) => {
      await expect(win.locator('.empty-tab-session').first()).toBeVisible({ timeout: 15000 })
    }
  },
  {
    name: 'лента',
    script: { steps: [], turns: [ALL_CATEGORIES] },
    open: async (win) => {
      await send(win, 'Почини вход')
      await expect(win.locator('[data-testid="ribbon-agentText"]').last()).toContainText('Готово', { timeout: 15000 })
      for (const c of ['command', 'edit']) {
        const card = win.locator(`.tool-card[data-category="${c}"]`).first()
        await card.locator('[data-testid="tool-head"]').click()
        await expect(card.locator('[data-testid="tool-detail"]')).toBeVisible()
      }
    }
  },
  {
    name: 'настройки',
    open: async (win) => {
      await win.keyboard.press('Control+,')
      await expect(win.locator('[data-testid="setting-globalHotkey"]')).toBeVisible()
    }
  },
  {
    name: 'история в боковой панели',
    env: () => HISTORY_ENV,
    open: async (win) => {
      await expect(win.locator('[data-testid="sidebar-session"]')).toHaveCount(3, { timeout: 15000 })
    }
  },
  {
    name: 'палитра',
    open: async (win) => {
      await win.keyboard.press('Control+k')
      await win.keyboard.press('ArrowDown')
      await expect(win.locator('.action-palette-item.is-selected')).toHaveCount(1)
    }
  },
  {
    name: 'установка',
    env: () => ({
      QCLOD_USER_DATA: missingAgentProfile(),
      QCLOD_FAKE_INSTALL: JSON.stringify({ methods: ['winget'], results: [] })
    }),
    open: async (win) => {
      await expect(win.locator('[data-testid="setup-install"]')).toBeVisible({ timeout: 20000 })
    }
  },
  {
    name: 'разрешение',
    script: { steps: [], turns: [[{ kind: 'text', text: 'сейчас запущу тесты' }, { kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]] },
    open: async (win) => {
      await send(win, 'прогони тесты')
      await expect(win.locator('[data-testid="pinned-card"] [data-testid="permission-allow"]')).toBeVisible({ timeout: 15000 })
    }
  },
  {
    name: 'панель 92%',
    script: { steps: [], contextPercent: 10, contextPercentByTurn: [92] },
    open: async (win) => {
      await send(win, 'первый')
      await expect(win.locator('[data-testid="panel-context"]')).toHaveAttribute('data-level', 'critical', { timeout: 15000 })
      await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()
    }
  }
]

for (const s of SCREENS) {
  test(`контраст текста ≥ 4.5:1 — ${s.name}`, async () => {
    const env = s.env?.()
    const own = env?.['QCLOD_USER_DATA']
    const { app, win } = await launchQclod({ ...(env ? { env } : {}), ...(s.script ? { script: s.script } : {}) })
    try {
      await s.open(win)
      // Past the sheets' fade-in: opacity mid-way would blend the colours being measured.
      await win.waitForTimeout(400)
      await shot(win, `10-${s.name}`)
      expect(await auditContrast(win)).toEqual([])
    } finally {
      await app.close()
      if (own) rmSync(own, { recursive: true, force: true })
    }
  })
}

test('аудит контраста ловит слабый текст и считает фон по смеси с родителем', async () => {
  const { app, win } = await launchQclod()
  try {
    await win.evaluate(() => {
      const box = document.createElement('div')
      box.id = 'probe'
      box.style.cssText = 'position:fixed;left:0;top:0;z-index:999;background:#16161a;padding:4px'
      // Too dark on graphite: caught.
      const dim = document.createElement('span')
      dim.textContent = 'тёмный'
      dim.style.color = '#333'
      // Readable on its own surface, but on a 90% white tint over it it is not.
      const tinted = document.createElement('span')
      tinted.textContent = 'на тонировке'
      tinted.style.cssText = 'color:#ececf1;background:color-mix(in srgb, white 90%, transparent)'
      // Fine, and hidden text is ignored.
      const fine = document.createElement('span')
      fine.textContent = 'светлый'
      fine.style.color = '#ececf1'
      const ghost = document.createElement('span')
      ghost.textContent = 'скрытый'
      ghost.style.color = '#333'
      ghost.setAttribute('aria-hidden', 'true')
      box.append(dim, tinted, fine, ghost)
      document.body.append(box)
    })
    const found = await auditContrast(win, '#probe')
    expect(found.map((f) => f.text).sort()).toEqual(['на тонировке', 'тёмный'])
  } finally {
    await app.close()
  }
})

test('«Сохранено» — цвет статуса у галочки, слова текстом', async () => {
  const { app, win } = await launchQclod()
  try {
    await win.keyboard.press('Control+,')
    await win.locator('[data-testid="setting-soundEnabled"]').click()
    const saved = win.locator('[data-testid="settings-saved"]')
    await expect(saved).toBeVisible()
    const look = await saved.evaluate((el) => ({
      text: getComputedStyle(el).color,
      icon: getComputedStyle(el.querySelector('svg')!).color
    }))
    expect(look).toEqual({ text: 'rgb(161, 161, 171)', icon: 'rgb(76, 195, 138)' }) // --text-dim, --status-ok
  } finally {
    await app.close()
  }
})

test('проверка установки не прошла — одна строка с причиной, не тишина', async () => {
  const profile = missingAgentProfile()
  const { app, win } = await launchQclod({
    env: { QCLOD_USER_DATA: profile, QCLOD_FAKE_INSTALL: JSON.stringify({ methods: ['winget'], results: [] }) }
  })
  try {
    await expect(win.locator('[data-testid="setup-install"]')).toBeVisible({ timeout: 20000 })
    // The seam is read on every call: from here on the check fails.
    await app.evaluate(() => {
      process.env['QCLOD_FAKE_FAIL'] = JSON.stringify({ 'setup:check': 'нет доступа к папке' })
    })
    await win.locator('[data-testid="setup-recheck"]').click()
    const error = win.locator('[data-testid="setup-check-error"]')
    await expect(error).toContainText('нет доступа к папке')
    expect(await error.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(24)
    await shot(win, '10-установка-ошибка')
    expect(await auditContrast(win)).toEqual([])

    // The next check that runs clears it.
    await app.evaluate(() => {
      delete process.env['QCLOD_FAKE_FAIL']
    })
    await win.locator('[data-testid="setup-recheck"]').click()
    await expect(error).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(profile, { recursive: true, force: true })
  }
})

test('модальные окна — один лист', async () => {
  const { app, win } = await launchQclod({ env: HISTORY_ENV })
  try {
    const opens: Array<(w: Page) => Promise<void>> = [
      (w) => w.keyboard.press('Control+,'),
      (w) => w.keyboard.press('Control+k')
    ]
    for (const open of opens) {
      await open(win)
      await expect(win.locator('.sheet')).toHaveCount(1)
      await expect(win.locator('.sheet-backdrop')).toHaveCount(1)
      const look = await win.locator('.sheet').evaluate((el) => {
        const s = getComputedStyle(el)
        return { bg: s.backgroundColor, radius: s.borderTopLeftRadius }
      })
      expect(look).toEqual({ bg: 'rgb(29, 29, 34)', radius: '10px' }) // --surface-raised, --radius-lg
      await win.keyboard.press('Escape')
      await expect(win.locator('.sheet')).toHaveCount(0)
    }
  } finally {
    await app.close()
  }
})

/** Every visible button of `sel` lies inside the window, edge to edge. */
async function expectButtonsInside(win: Page, sel: string, width: number): Promise<void> {
  for (const b of await win.locator(sel).all()) {
    if (!(await b.isVisible())) continue
    const box = await b.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= width, `${sel}: ${await b.evaluate((e) => e.outerHTML.slice(0, 90))}`).toBe(true)
  }
}

/** The status line is one row whose content fits it: nothing wraps, nothing spills past its edge. */
async function expectStatusLineFits(win: Page): Promise<void> {
  const fit = await win.locator('[data-testid="status-line"]').evaluate((line) => {
    const box = line.getBoundingClientRect()
    const rows = new Set<number>()
    let spill = 0
    for (const child of line.querySelectorAll('button, .status-meter')) {
      const r = child.getBoundingClientRect()
      if (r.width === 0) continue
      rows.add(Math.round(r.top / 4))
      spill = Math.max(spill, box.left - r.left, r.right - box.right)
    }
    // A list squeezed to nothing (or to less than its content) still paints over its neighbours.
    const squeezed = [...line.querySelectorAll('.dropdown')].filter(
      (d) => d.getClientRects().length > 0 && (d.clientWidth === 0 || d.scrollWidth - d.clientWidth > 1)
    ).length
    return { rows: rows.size, spill, squeezed, overflow: line.scrollWidth - line.clientWidth }
  })
  expect(fit.rows).toBe(1)
  expect(fit.squeezed).toBe(0)
  expect(fit.spill).toBeLessThanOrEqual(0.5)
  expect(fit.overflow).toBeLessThanOrEqual(0)
}

test('800×600 — нет горизонтальной прокрутки, кнопки строки статуса и заголовка видны целиком', async () => {
  const { app, win } = await launchQclod({ size: { width: 800, height: 600 }, script: { steps: [] } })
  try {
    expect(await win.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await expectButtonsInside(win, '[data-testid="title-bar"] button', 800)
    await expectButtonsInside(win, '[data-testid="status-line"] button', 800)
    await expectStatusLineFits(win)
    await shot(win, '12-min-size')
  } finally {
    await app.close()
  }
})

test('800×600 с панелью, открытой вручную, — строка статуса в одну строку и не вылезает', async () => {
  const { app, win } = await launchQclod({ size: { width: 800, height: 600 }, script: { steps: [] } })
  try {
    await win.locator('[data-testid="panel-open"]').click()
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()
    expect(await win.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await expectButtonsInside(win, '[data-testid="status-line"] button', 800)
    await expectStatusLineFits(win)
    await shot(win, '12-min-size-panel')
  } finally {
    await app.close()
  }
})

/**
 * The owner's look at every screen: `QCLOD_SHOT=1 QCLOD_SHOT_DIR=<dir> npx playwright test screens -g снимки`.
 * Not assertions beyond "the state is on screen"; always the fake SDK, always the invisible window.
 */
test.describe('снимки для владельца', () => {
  test.skip(process.env['QCLOD_SHOT'] !== '1', 'снимки делаются только по QCLOD_SHOT=1')

  const SIZE = { width: 1180, height: 760 }
  const COMMANDS = [
    { name: 'compact', description: 'Сжать контекст', argumentHint: '', builtin: true },
    { name: 'model', description: 'Сменить модель', argumentHint: '<model>', builtin: true },
    { name: 'resume', description: 'Открыть прошлую сессию', argumentHint: '', builtin: true },
    { name: 'моя-команда', description: 'Команда из этого проекта', argumentHint: '' }
  ]
  const profiles: string[] = []
  test.afterEach(() => {
    for (const dir of profiles.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  })

  /** A profile of our own (the launcher keeps it), with optional files written into it. */
  function profileWith(files: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-final-'))
    profiles.push(dir)
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body), 'utf8')
    return dir
  }

  function missingAgent(): string {
    const dir = missingAgentProfile()
    profiles.push(dir)
    return dir
  }

  /** Launches, runs the scenario, takes one shot after the fade-ins settle, closes. */
  async function take(
    name: string,
    opts: { script?: unknown; env?: Record<string, string>; size?: { width: number; height: number } },
    scenario: (win: Page) => Promise<void>
  ): Promise<void> {
    const { app, win } = await launchQclod({
      size: opts.size ?? SIZE,
      ...(opts.script ? { script: opts.script } : {}),
      ...(opts.env ? { env: opts.env } : {})
    })
    try {
      await scenario(win)
      await win.waitForTimeout(450)
      await shot(win, `final-${name}`)
    } finally {
      await app.close()
    }
  }

  const agent = (name: string, agentType: string, lastTool: string): unknown => ({
    kind: 'backgroundAgent',
    name,
    agentType,
    pauseMs: 200,
    progress: [{ tokens: 500, toolUses: 1, durationMs: 3000, lastTool }],
    finish: null
  })
  const ribbonScript = { steps: [], turns: [ALL_CATEGORIES] }
  const fullRibbon = async (win: Page): Promise<void> => {
    await send(win, 'Почини вход')
    await expect(win.locator('[data-testid="ribbon-agentText"]').last()).toContainText('Готово', { timeout: 15000 })
  }
  const openCard = async (win: Page, category: string): Promise<void> => {
    const card = win.locator(`.tool-card[data-category="${category}"]`).first()
    await card.locator('[data-testid="tool-head"]').click()
    await expect(card.locator('[data-testid="tool-detail"]')).toBeVisible()
  }

  test('01 пустая вкладка', async () => {
    await take('01-пустая-вкладка', { env: HISTORY_ENV }, async (win) => {
      await expect(win.locator('.empty-tab-session').first()).toBeVisible({ timeout: 15000 })
    })
  })
  test('02 лента со всеми категориями', async () => {
    await take('02-лента', { script: ribbonScript }, fullRibbon)
  })
  test('03 раскрытая команда', async () => {
    await take('03-команда', { script: ribbonScript }, async (win) => {
      await fullRibbon(win)
      await openCard(win, 'command')
    })
  })
  test('04 раскрытая правка с диффом', async () => {
    await take('04-правка', { script: ribbonScript }, async (win) => {
      await fullRibbon(win)
      await openCard(win, 'edit')
    })
  })
  test('05 подагент с лентой шагов', async () => {
    await take('05-подагент', { script: ribbonScript }, async (win) => {
      await fullRibbon(win)
      await win.locator('[data-testid="subagent-head"]').first().click()
      await expect(win.locator('[data-testid="ribbon-subagent"]').first()).toContainText('leak')
    })
  })
  test('06 строка «сейчас», список агентов', async () => {
    const script = { steps: [agent('прогнать тесты', 'builder', 'Bash'), agent('найти вызовы', 'Explore', 'Grep')] }
    await take('06-сейчас-агенты', { script }, async (win) => {
      const button = win.locator('[data-testid="now-agents"]')
      await expect(button).toHaveText('2 агента', { timeout: 15000 })
      await button.click()
      await expect(win.locator('[data-testid="now-agents-list"] li')).toHaveCount(2)
      await expect(win.locator('[data-testid="now-agents-list"] li').first()).toContainText('Bash', { timeout: 10000 })
      // The panel no longer lists subagents (решение 10); nowhere is a call counted as «инструментов».
      await expect(win.locator('[data-testid="ribbon"]')).not.toContainText('инструментов')
    })
  })
  test('07 полоска задач раскрыта', async () => {
    const script = {
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
    }
    await take('07-задачи', { script }, async (win) => {
      await win.locator('[data-testid="todo-strip"]').click({ timeout: 15000 })
      await expect(win.locator('[data-testid="todo-list"]')).toBeVisible()
    })
  })
  test('08 список «/»', async () => {
    await take('08-слэш', { script: { steps: [], init: { commands: COMMANDS } } }, async (win) => {
      const input = win.locator('[data-testid="composer-input"]')
      await input.click()
      await input.press('/')
      await expect(win.locator('[data-testid="slash-menu"]')).toBeVisible()
    })
  })
  test('09 второй шаг /model', async () => {
    await take('09-модель', { script: { steps: [], init: { commands: COMMANDS } } }, async (win) => {
      const input = win.locator('[data-testid="composer-input"]')
      await input.click()
      await input.press('/')
      await input.pressSequentially('model')
      await input.press('Enter')
      await expect(win.locator('[data-testid="slash-item"]')).toHaveCount(2)
    })
  })
  test('10 меню пути', async () => {
    const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'qclod-final-proj-')))
    mkdirSync(join(project, 'src'))
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    const dir = profileWith({ 'tabs.json': [{ id: 'a', cwd: project, title: 'Пути', overrides: {} }] })
    try {
      await take(
        '10-меню-пути',
        {
          script: { steps: [{ kind: 'text', text: 'Правил src/a.ts:3 и ещё кое-что.' }] },
          env: { QCLOD_USER_DATA: dir, QCLOD_FAKE_SHELL: '1' }
        },
        async (win) => {
          const link = win.locator('[data-testid="path-link"]').first()
          await expect(link).toBeVisible({ timeout: 15000 })
          await link.click({ button: 'right' })
          await expect(win.locator('[data-testid="path-menu"]')).toBeVisible()
        }
      )
    } finally {
      rmSync(project, { recursive: true, force: true, maxRetries: 3 })
    }
  })
  test('11 строка статуса 82%', async () => {
    await take('11-статус-82', { script: { steps: [], contextPercent: 82 } }, async (win) => {
      await expect(win.locator('[data-testid="status-context"]')).toContainText('82%', { timeout: 15000 })
      await expect(win.locator('[data-testid="status-context-alert"]')).toBeVisible()
    })
  })
  test('12 плашка 92% и панель с разбивкой', async () => {
    await take('12-плашка-92', { script: { steps: [], contextPercent: 10, contextPercentByTurn: [92] } }, async (win) => {
      await send(win, 'первый')
      await expect(win.locator('[data-testid="context-banner"]')).toBeVisible({ timeout: 15000 })
      await expect(win.locator('[data-testid="panel-context"]')).toHaveAttribute('data-level', 'critical')
    })
  })
  test('13 карточка разрешения, фокус на главной кнопке', async () => {
    const script = {
      steps: [],
      turns: [[{ kind: 'text', text: 'сейчас запущу тесты' }, { kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]]
    }
    await take('13-разрешение', { script }, async (win) => {
      await send(win, 'прогони тесты')
      const allow = win.locator('[data-testid="pinned-card"] [data-testid="permission-allow"]')
      await expect(allow).toBeVisible({ timeout: 15000 })
      await allow.focus()
      await expect(allow).toBeFocused()
    })
  })
  test('14 вопрос агента', async () => {
    const script = { steps: [{ kind: 'askQuestion', question: 'Какой вариант панели?', options: ['Справа', 'Снизу'] }] }
    await take('14-вопрос', { script }, async (win) => {
      await expect(win.locator('[data-testid="question-card"]')).toBeVisible({ timeout: 15000 })
    })
  })
  test('15 палитра Ctrl+K', async () => {
    await take('15-палитра', {}, async (win) => {
      await win.keyboard.press('Control+k')
      await win.keyboard.press('ArrowDown')
      await expect(win.locator('.action-palette-item.is-selected')).toHaveCount(1)
    })
  })
  test('16 настройки', async () => {
    await take('16-настройки', {}, async (win) => {
      await win.keyboard.press('Control+,')
      await expect(win.locator('[data-testid="setting-globalHotkey"]')).toBeVisible()
    })
  })
  test('17 настройки, правила разрешений', async () => {
    const dir = profileWith({
      'permission-rules.json': [
        { id: 'r1', toolName: 'Bash', target: 'npm test', behavior: 'allow' },
        { id: 'r2', toolName: 'Edit', target: 'C:\\проект\\src\\a.ts', behavior: 'allow' },
        { id: 'r3', toolName: 'Bash', target: 'git status', behavior: 'allow' }
      ]
    })
    await take('17-правила', { env: { QCLOD_USER_DATA: dir } }, async (win) => {
      await win.keyboard.press('Control+,')
      const rules = win.locator('[data-testid="permission-rules"]')
      await expect(rules.locator('[data-testid="permission-rule"]')).toHaveCount(3)
      await rules.scrollIntoViewIfNeeded()
    })
  })
  test('18 история в боковой панели', async () => {
    await take('18-история', { env: HISTORY_ENV }, async (win) => {
      await expect(win.locator('[data-testid="sidebar-session"]')).toHaveCount(3, { timeout: 15000 })
    })
  })
  test('19 история, загрузка', async () => {
    await take('19-история-загрузка', { env: { QCLOD_FAKE_SLOW: '{"projects:history":6000}' } }, async (win) => {
      await expect(win.locator('[data-testid="sidebar"] [data-state="loading"]')).toContainText('Загружаю…')
    })
  })
  test('20 история, ошибка', async () => {
    await take('20-история-ошибка', { env: { QCLOD_FAKE_FAIL: '{"projects:history":"нет доступа"}' } }, async (win) => {
      await expect(win.locator('[data-testid="sidebar"] [data-state="error"]')).toContainText('нет доступа', {
        timeout: 10000
      })
    })
  })
  test('21 лента не загрузилась', async () => {
    await take('21-лента-ошибка', { env: { QCLOD_FAKE_FAIL: '{"agent:ribbon":"сессия занята"}' } }, async (win) => {
      await expect(win.locator('[data-testid="chat-pane"] [data-state="error"]')).toContainText('сессия занята', {
        timeout: 10000
      })
    })
  })
  test('22 установка, агент не найден', async () => {
    const env = { QCLOD_USER_DATA: missingAgent(), QCLOD_FAKE_INSTALL: JSON.stringify({ methods: ['winget'], results: [] }) }
    await take('22-установка', { env }, async (win) => {
      await expect(win.locator('[data-testid="setup-install"]')).toBeVisible({ timeout: 20000 })
    })
  })
  test('23 установка, журнал', async () => {
    // The installer fake answers in 50 ms, so the log is shot as it stands after winget fails and npm is tried.
    const env = {
      QCLOD_USER_DATA: missingAgent(),
      QCLOD_FAKE_INSTALL: JSON.stringify({ methods: ['winget', 'npm'], results: [false, false] })
    }
    await take('23-установка-журнал', { env }, async (win) => {
      await win.locator('[data-testid="setup-install"]').click({ timeout: 20000 })
      await expect(win.locator('[data-testid="setup-log"]')).toContainText('пробую через npm', { timeout: 10000 })
    })
  })
  test('24 очередь сообщений', async () => {
    const script = {
      steps: [],
      turns: [[{ kind: 'textStream', pieces: ['думаю ', 'ещё ', 'немного ', 'готово'], pauseMs: 4000 }]],
      nextTurn: [{ kind: 'text', text: 'закоммитил' }]
    }
    await take('24-очередь', { script }, async (win) => {
      await send(win, 'сделай фичу')
      await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 15000 })
      await send(win, 'и потом закоммить')
      await expect(win.locator('[data-testid="queue-item"]')).toBeVisible()
    })
  })
  test('25 фоновые задачи', async () => {
    const script = {
      steps: [],
      nextTurn: [{ kind: 'backgroundBash', command: 'npm run dev', chunks: ['готово 1\n', 'готово 2\n'], pauseMs: 200, finish: null }]
    }
    await take('25-фоновые', { script }, async (win) => {
      await send(win, 'запусти сервер')
      const counter = win.locator('[data-testid="status-bg"]')
      await expect(counter).toHaveText('Фоновые 1', { timeout: 15000 })
      await counter.click()
      await win.locator('[data-testid="bg-task-toggle"]').click()
      await expect(win.locator('[data-testid="bg-output"]')).toContainText('готово 2', { timeout: 5000 })
    })
  })
  test('26 Tab-обход заголовка, кольцо фокуса', async () => {
    await take('26-tab-заголовок', {}, async (win) => {
      await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const inTitleBar = (): Promise<boolean> =>
        win.evaluate(() => document.activeElement?.closest('[data-testid="title-bar"]') != null)
      for (let i = 0; i < 40 && !(await inTitleBar()); i++) await win.keyboard.press('Tab')
      expect(await inTitleBar()).toBe(true)
      // Two stops further in, so the ring is on a control and not only on the first tab.
      await win.keyboard.press('Tab')
      await win.keyboard.press('Tab')
      expect(await inTitleBar()).toBe(true)
      await expectFocusRing(win)
    })
  })
  test('27 минимальный размер', async () => {
    await take('27-мин-размер', { script: { steps: [] }, size: { width: 800, height: 600 } }, async (win) => {
      await expect(win.locator('[data-testid="status-context"]')).toBeVisible({ timeout: 15000 })
    })
  })
})
