import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditContrast } from './helpers/contrast'
import { launchQclod } from './helpers/launch'
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
    name: 'история',
    env: () => HISTORY_ENV,
    open: async (win) => {
      await win.keyboard.press('Control+H')
      await expect(win.locator('[data-testid="history-item"]')).toHaveCount(3)
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
      await expect(win.locator('[data-testid="permission-allow"]')).toBeVisible({ timeout: 15000 })
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
      (w) => w.keyboard.press('Control+H'),
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
