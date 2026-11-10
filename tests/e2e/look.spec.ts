import { test, expect, type Page } from '@playwright/test'
import { expectFocusRing, launchQclod } from './helpers/launch'
import { shot } from './helpers/shot'

test('окно и страница непрозрачные, нигде нет размытия', async () => {
  const { app, win } = await launchQclod()
  try {
    const bg = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor())
    expect(bg.toLowerCase()).toBe('#0f0f11')
    expect(await win.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(15, 15, 17)')
    const blurred = await win.evaluate(
      () => [...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).backdropFilter !== 'none').length
    )
    expect(blurred).toBe(0)
    await shot(win, '02-window')
  } finally {
    await app.close()
  }
})

const FONTS_ANSWER = [
  '## Что нашёл',
  '',
  'Нашёл, где теряется токен: функция `refresh()` возвращает старое значение, если запрос обновления упал. Ниже — файл и строка, которую стоит поправить.',
  '',
  '```ts',
  "// C:\\Users\\Иван\\проект\\файл.ts",
  'const token = await refresh() // 42 мс',
  '```'
].join('\n')

test('проза — Inter, код — Geist Mono с кириллицей, шрифты не из сети', async () => {
  const { app, win } = await launchQclod({ script: { steps: [{ kind: 'text', text: FONTS_ANSWER }] } })
  try {
    const row = win.locator('[data-testid="ribbon-agentText"]').first()
    await expect(row.locator('[data-testid="md-code"]')).toContainText('Иван', { timeout: 15000 })

    const family = (sel: string): Promise<string> =>
      row.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily)
    expect(await family('.md-p')).toMatch(/^"?Inter Variable/)
    expect(await family('.md-code')).toMatch(/^"?Geist Mono Variable/)
    expect(await family('.md-pre code')).toMatch(/^"?Geist Mono Variable/)
    expect(await family('.md-codeblock-lang')).toMatch(/^"?Inter Variable/)

    expect(
      await win.evaluate(async () => {
        await document.fonts.load('12px "Geist Mono Variable"', 'Иван')
        await document.fonts.load('14px "Inter Variable"', 'Привет')
        await document.fonts.ready
        return (
          document.fonts.check('12px "Geist Mono Variable"', 'Иван') &&
          document.fonts.check('14px "Inter Variable"', 'Привет')
        )
      })
    ).toBe(true)
    // check() is also true when no face matches at all, so prove the Cyrillic face itself loaded:
    // a loaded face of the family whose unicode-range covers every letter of the Cyrillic text.
    // The latin subset (U+0000-00FF, …) does not cover U+0413 «Г», so a latin-only load fails here.
    const cyrillicFace = (family: string, text: string): Promise<string | null> =>
      win.evaluate(
        ({ family, text }) => {
          const covers = (range: string, cp: number): boolean =>
            range.split(',').some((part) => {
              const [lo, hi] = part.trim().replace(/^U\+/i, '').split('-')
              return cp >= parseInt(lo, 16) && cp <= parseInt(hi ?? lo, 16)
            })
          const face = [...document.fonts].find(
            (f) =>
              f.family.replace(/["']/g, '') === family &&
              f.status === 'loaded' &&
              [...text].every((ch) => covers(f.unicodeRange, ch.codePointAt(0)!))
          )
          return face ? face.unicodeRange : null
        },
        { family, text }
      )
    expect(await cyrillicFace('Geist Mono Variable', 'Иван')).toMatch(/U\+0*400-0*45F/i)
    expect(await cyrillicFace('Inter Variable', 'Привет')).toMatch(/U\+0*400-0*45F/i)

    // Chromium writes no resource-timing entries for file:// loads, so the font sources are read
    // from the @font-face rules themselves, resolved against their stylesheet: every one is local.
    const fontSources = await win.evaluate(() =>
      [...document.styleSheets].flatMap((sheet) =>
        [...sheet.cssRules]
          .filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule)
          .flatMap((rule) =>
            [...rule.style.getPropertyValue('src').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map(
              (m) => new URL(m[1], sheet.href ?? location.href).href
            )
          )
      )
    )
    expect(fontSources.filter((u) => /\.woff2$/.test(u)).length).toBeGreaterThan(0)
    const local = /^(file:|http:\/\/localhost[:/])/
    expect(fontSources.filter((u) => !local.test(u))).toEqual([])
    const remote = await win.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => /\.woff2/.test(n))
    )
    expect(remote.filter((n) => !local.test(n))).toEqual([])
    await shot(win, '03-fonts')
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()
    await shot(win, '04-type')
  } finally {
    await app.close()
  }
})

/** After the user's own message, one card of every category: read, search, edit, command, MCP, plan, other, agent. */
const ALL_CATEGORIES = [
  { kind: 'text', text: 'Смотрю, как устроен вход.' },
  { kind: 'tool', name: 'Read', input: { file_path: 'C:/проект/auth.ts' }, result: 'строка 1\nстрока 2' },
  { kind: 'tool', name: 'Grep', input: { pattern: 'login', path: 'src' }, result: 'src/a.ts\nsrc/b.ts' },
  { kind: 'tool', name: 'Edit', input: { file_path: 'C:/проект/a.ts', old_string: 'b', new_string: 'c\nd' }, result: 'The file has been updated.' },
  { kind: 'tool', name: 'Bash', input: { command: 'npm test', description: 'Run tests' }, result: 'ok' },
  { kind: 'tool', name: 'mcp__gh__x', input: { title: 'Баг', labels: ['a'] }, result: 'создано' },
  { kind: 'tool', name: 'EnterPlanMode', input: {}, result: 'ok' },
  { kind: 'tool', name: 'Skill', input: { skill: 'review' }, result: 'ok' },
  { kind: 'subagent', name: 'найти утечку', steps: [{ kind: 'tool', name: 'Grep', input: { pattern: 'leak' }, result: 'нашёл' }] },
  { kind: 'text', text: 'Готово. Правил `src/a.ts:3`.' }
]

// The colours themselves are held by the unit tests (tokens.test.ts, styleRules.test.ts); these are the owner's pictures.
test('05 лента со всеми категориями и список /', async () => {
  const commands = [
    { name: 'compact', description: 'Сжать контекст', argumentHint: '', builtin: true },
    { name: 'model', description: 'Сменить модель', argumentHint: '<model>', builtin: true },
    { name: 'моя-команда', description: 'Команда из этого проекта', argumentHint: '' }
  ]
  const { app, win } = await launchQclod({ script: { steps: [], turns: [ALL_CATEGORIES], init: { commands } } })
  try {
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })
    await input.fill('Почини вход')
    await input.press('Enter')
    await expect(win.locator('.row-user').first()).toContainText('Почини вход', { timeout: 15000 })
    await expect(win.locator('[data-testid="ribbon-subagent"]').first()).toBeVisible({ timeout: 15000 })
    for (const c of ['read', 'search', 'edit', 'command', 'mcp', 'plan', 'other']) {
      await expect(win.locator(`.tool-card[data-category="${c}"]`).first()).toBeVisible()
    }
    await expect(win.locator('[data-testid="ribbon-agentText"]').last()).toContainText('Готово', { timeout: 15000 })
    await shot(win, '05-chat')

    await input.click()
    await input.press('/')
    const menu = win.locator('[data-testid="slash-menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.locator('[data-testid="slash-item"]').first()).toBeVisible()
    await shot(win, '05-menu')
  } finally {
    await app.close()
  }
})

// ---------------------------------------------------------------- focus (Task 6)

const DAY = 24 * 60 * 60 * 1000
const TWO_SESSIONS = {
  sessions: [
    { sessionId: 'сессия-1', summary: 'Починка вставки файлов', lastModified: Date.now() - 2 * DAY, firstPrompt: 'вставка файлов не работает' },
    { sessionId: 'сессия-2', summary: 'Переезд на SDK', lastModified: Date.now() - 5 * DAY, firstPrompt: 'давай перепишем ядро' }
  ]
}
const focusEnv = { QCLOD_FAKE_HISTORY: JSON.stringify(TWO_SESSIONS) }

/** What has focus, short enough to tell controls apart. */
const focused = (win: Page): Promise<string> =>
  win.evaluate(() => {
    const a = document.activeElement as HTMLElement
    return a === document.body ? 'body' : a.outerHTML.slice(0, 80)
  })

/** How each screen is opened, and how many stops Tab must find there. */
const SCREENS: { where: string; open: (win: Page) => Promise<void>; sheet?: string; minStops: number }[] = [
  {
    where: 'главный экран',
    // Start from nothing focused: Tab then walks the title bar first. The input
    // keeps Tab for itself (it cycles the mode), so the walk ends there.
    open: async (win) => {
      await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    },
    minStops: 4
  },
  {
    where: 'настройки',
    open: async (win) => {
      await win.keyboard.press('Control+,')
      await expect(win.locator('[data-testid="settings"]')).toBeVisible()
    },
    sheet: '.settings',
    minStops: 4
  },
  {
    where: 'история',
    open: async (win) => {
      await win.keyboard.press('Control+H')
      await expect(win.locator('[data-testid="history-item"]')).toHaveCount(2)
    },
    sheet: '.history',
    minStops: 4
  },
  {
    where: 'палитра',
    // One field; the list follows it by aria-activedescendant. Tab stays put.
    open: async (win) => {
      await win.keyboard.press('Control+k')
      await expect(win.locator('[data-testid="action-palette"]')).toBeVisible()
    },
    sheet: '.action-palette',
    minStops: 1
  }
]

for (const { where, open, sheet, minStops } of SCREENS) {
  test(`Tab по «${where}» — у каждого фокуса видно кольцо`, async () => {
    const { app, win } = await launchQclod({ env: focusEnv })
    try {
      await open(win)
      const seen = new Set<string>()
      for (let i = 0; i < 40; i++) {
        await win.keyboard.press('Tab')
        const id = await focused(win)
        expect(id).not.toBe('body')
        // A modal sheet keeps Tab inside itself.
        if (sheet) expect(await win.evaluate((s) => !!document.activeElement?.closest(s), sheet)).toBe(true)
        if (seen.has(id)) break
        seen.add(id)
        await expectFocusRing(win)
      }
      expect(seen.size).toBeGreaterThanOrEqual(minStops)
      await shot(win, `06-focus-${where}`)
    } finally {
      await app.close()
    }
  })
}

test('в палитре выбранная строка — заливка наведения и полоса акцента слева', async () => {
  const { app, win } = await launchQclod()
  try {
    await win.keyboard.press('Control+k')
    await win.keyboard.press('ArrowDown')
    const row = win.locator('.action-palette-item.is-selected')
    await expect(row).toHaveCount(1)
    const look = await row.evaluate((el) => {
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, stripe: s.boxShadow }
    })
    expect(look.bg).toBe('rgb(38, 38, 45)') // --surface-hover
    expect(look.stripe).toContain('rgb(90, 139, 255)')
    expect(look.stripe).toMatch(/inset/)
    expect(look.stripe).toContain('2px 0px 0px 0px')
    await expectFocusRing(win)
  } finally {
    await app.close()
  }
})

test('Esc закрывает настройки и возвращает фокус на кнопку настроек', async () => {
  const { app, win } = await launchQclod()
  try {
    const button = win.locator('[data-testid="open-settings"]')
    await button.focus()
    await win.keyboard.press('Enter')
    await expect(win.locator('[data-testid="settings"]')).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(win.locator('[data-testid="settings"]')).toHaveCount(0)
    await expect(button).toBeFocused()
    await expectFocusRing(win)
  } finally {
    await app.close()
  }
})

test('Esc закрывает историю и возвращает фокус на кнопку истории', async () => {
  const { app, win } = await launchQclod({ env: focusEnv })
  try {
    const button = win.locator('[data-testid="open-history"]')
    await button.focus()
    await win.keyboard.press('Enter')
    await expect(win.locator('[data-testid="history-item"]')).toHaveCount(2)
    // Esc works from a row too, not only from the search field.
    await win.keyboard.press('Tab')
    await win.keyboard.press('Escape')
    await expect(win.locator('[data-testid="history-screen"]')).toHaveCount(0)
    await expect(button).toBeFocused()
    await expectFocusRing(win)
  } finally {
    await app.close()
  }
})

test('при масштабе 80% кольцо фокуса не пропадает', async () => {
  const { app, win } = await launchQclod()
  try {
    await win.keyboard.press('Control+-')
    await win.keyboard.press('Control+-')
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomLevel()))
      .toBe(-1)
    // The input's frame...
    await win.locator('[data-testid="composer-input"]').focus()
    await win.keyboard.press('Tab')
    await expectFocusRing(win)
    // ...and a button's own outline.
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await win.keyboard.press('Tab')
    await expectFocusRing(win)
    await shot(win, '06-focus-zoom-80')
  } finally {
    await app.close()
  }
})
