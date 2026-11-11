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

/**
 * What has focus, as a stable name: its test id and which of the elements with
 * that id it is. A prefix of outerHTML is not enough — «status-mode» and
 * «status-model» share one, and the walk then stops on a false repeat.
 */
const focused = (win: Page): Promise<string> =>
  win.evaluate(() => {
    const a = document.activeElement as HTMLElement
    if (a === document.body) return 'body'
    const id = a.getAttribute('data-testid')
    if (id === null) return a.outerHTML.slice(0, 160)
    const same = [...document.querySelectorAll(`[data-testid="${id}"]`)]
    return `${a.tagName.toLowerCase()}[${id}]#${same.indexOf(a)}`
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

test('у скрепки своё кольцо, рамка поля ввода загорается только от самого поля', async () => {
  const { app, win } = await launchQclod({ env: focusEnv })
  try {
    const rowShadow = (): Promise<string> =>
      win.locator('.composer-row').evaluate((el) => getComputedStyle(el).boxShadow)
    // The clip comes right after the last recent conversation in Tab order.
    await win.locator('[data-testid="empty-recent"]').last().focus()
    await win.keyboard.press('Tab')
    await expect(win.locator('[data-testid="composer-clip"]')).toBeFocused()
    await expectFocusRing(win)
    expect(await rowShadow()).not.toContain('rgb(90, 139, 255)')
    await win.keyboard.press('Tab')
    await expect(win.locator('[data-testid="composer-input"]')).toBeFocused()
    await expect.poll(rowShadow).toContain('rgb(90, 139, 255)')
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

// Two Ctrl+- give zoom level -1 (83%), two Ctrl+= give +1 (120%): the steps nearest 80% and 125%.
for (const { name, key, level } of [
  { name: '80%', key: 'Control+-', level: -1 },
  { name: '120%', key: 'Control+=', level: 1 }
]) {
  test(`при масштабе ${name} кольцо фокуса не пропадает`, async () => {
    const { app, win } = await launchQclod()
    try {
      await win.keyboard.press(key)
      await win.keyboard.press(key)
      await expect
        .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomLevel()))
        .toBe(level)
      // The input's frame...
      await win.locator('[data-testid="composer-input"]').focus()
      await win.keyboard.press('Tab')
      await expectFocusRing(win)
      // ...and a button's own outline (the send button comes next after the input).
      await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await win.keyboard.press('Tab')
      await expect(win.locator('[data-testid="composer-send"]')).toBeFocused()
      await expectFocusRing(win)
      await shot(win, `06-focus-zoom-${name.replace('%', '')}`)
    } finally {
      await app.close()
    }
  })
}

// ---------------------------------------------------------------- selection (Task 7)

test('двойной клик выделяет слово в ленте, выводе и панели, но не во вкладке заголовка', async () => {
  const { app, win } = await launchQclod({ script: { steps: [], turns: [ALL_CATEGORIES] } })
  try {
    const input = win.locator('[data-testid="composer-input"]')
    await input.waitFor({ timeout: 15000 })
    await input.fill('Почини вход')
    await input.press('Enter')
    await expect(win.locator('[data-testid="ribbon-agentText"]').last()).toContainText('Готово', { timeout: 15000 })
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()
    const selected = async (sel: string): Promise<string> => {
      await win.evaluate(() => document.getSelection()?.removeAllRanges())
      await win.locator(sel).first().dblclick()
      return win.evaluate(() => document.getSelection()?.toString() ?? '')
    }
    expect(await selected('[data-testid="ribbon-agentText"] .md-p')).not.toBe('')
    await win.locator('.tool-card[data-category="command"] [data-testid="tool-head"]').first().click()
    expect(await selected('[data-testid="tool-stdout"]')).not.toBe('')
    expect(await selected('[data-testid="panel-context"] .panel-line span')).not.toBe('')
    expect(await selected('[data-testid="tab"] .tab-title')).toBe('')
  } finally {
    await app.close()
  }
})

// ---------------------------------------------------------------- icons (Task 8)

test('значки кнопок окна одного размера', async () => {
  const { app, win } = await launchQclod()
  try {
    const sizes = await win
      .locator('[data-testid="title-bar"] .window-controls svg')
      .evaluateAll((s) => s.map((x) => x.getAttribute('width')))
    expect(sizes.length).toBeGreaterThanOrEqual(6)
    expect(new Set(sizes).size).toBe(1)
    // The same line weight too: a square drawn heavier than its neighbours reads as a different size.
    const strokes = await win
      .locator('[data-testid="title-bar"] .window-controls svg')
      .evaluateAll((s) => s.map((x) => `${x.getAttribute('stroke-width')}|${getComputedStyle(x).strokeWidth}`))
    expect(new Set(strokes).size).toBe(1)
  } finally {
    await app.close()
  }
})

test('80% и 92% — разные значки уровня в панели и строке статуса', async () => {
  const { app, win } = await launchQclod({ script: { steps: [], contextPercent: 10, contextPercentByTurn: [82, 92] } })
  try {
    const input = win.locator('[data-testid="composer-input"]')
    const send = async (text: string): Promise<void> => {
      await input.click()
      await input.fill(text)
      await input.press('Enter')
    }
    const panel = win.locator('[data-testid="panel-context"]')
    const status = win.locator('[data-testid="status-context"]')
    await expect(status).toContainText('10%', { timeout: 15000 })
    await expect(panel.locator('[data-level-icon]')).toHaveCount(0)

    await send('первый')
    await expect(panel.locator('[data-level-icon="warn"]')).toHaveClass(/lucide-triangle-alert/, { timeout: 15000 })
    await expect(status.locator('[data-level-icon="warn"]')).toHaveClass(/lucide-triangle-alert/)
    await expect(status.locator('[data-level-icon="warn"]')).toHaveAttribute('aria-label', 'Контекст заполняется')

    await send('второй')
    await expect(panel.locator('[data-level-icon="critical"]')).toHaveClass(/lucide-octagon-alert/, { timeout: 15000 })
    await expect(status.locator('[data-level-icon="critical"]')).toHaveAttribute('aria-label', 'Контекст почти заполнен')
    await expect(win.locator('[data-testid="context-banner"] [data-level-icon="critical"]')).toBeVisible()
    await shot(win, '08-levels')
  } finally {
    await app.close()
  }
})

// ------------------------------------------------- ribbon, status line, meters (Task 11)

const TEXT_DIM = 'rgb(161, 161, 171)'
const CRITICAL = 'rgb(255, 99, 105)'

const meterParts = (win: Page) => {
  const meter = win.locator('[data-testid="status-context"]')
  const style = (sel: string, prop: 'backgroundColor' | 'color' | 'fontVariantNumeric') =>
    meter.locator(sel).evaluate((e, p) => getComputedStyle(e)[p], prop)
  return { meter, style }
}

test('индикатор: обычный уровень без статусного цвета, подпись текстовым токеном, концы скруглены', async () => {
  const { app, win } = await launchQclod({ script: { steps: [], contextPercent: 42, contextPercentByTurn: [92] } })
  try {
    const { meter, style } = meterParts(win)
    await expect(meter).toContainText('42%', { timeout: 15000 })
    await expect(meter.locator('.meter')).toHaveAttribute('data-level', 'ok')
    expect(await style('.meter-fill', 'backgroundColor')).toBe(TEXT_DIM)
    expect(await style('.meter-label', 'color')).toBe(TEXT_DIM)
    expect(await style('.meter-label', 'fontVariantNumeric')).toContain('tabular-nums')
    const [radius, height] = await meter
      .locator('.meter-fill')
      .evaluate((e) => [parseFloat(getComputedStyle(e).borderRadius), e.getBoundingClientRect().height])
    expect(radius).toBeGreaterThanOrEqual(height / 2 - 0.5)
    // The panel's limit bars are the same meter (its context is the breakdown chart, not a meter).
    const panelFill = win.locator('[data-testid="side-panel"] .panel-limit .meter-fill').first()
    expect(await panelFill.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(TEXT_DIM)
    await shot(win, '11-status-42')

    const input = win.locator('[data-testid="composer-input"]')
    await input.click()
    await input.fill('дальше')
    await input.press('Enter')
    await expect(meter).toContainText('92%', { timeout: 15000 })
    await expect(meter.locator('.meter')).toHaveAttribute('data-level', 'critical')
    // The fill eases into its new colour.
    await expect.poll(() => style('.meter-fill', 'backgroundColor')).toBe(CRITICAL)
    expect(await style('.meter-label', 'color')).toBe(TEXT_DIM)
    await shot(win, '11-status-92')
  } finally {
    await app.close()
  }
})

test('строка статуса в одну строку при открытой панели: значки уровня и Remote Control на месте', async () => {
  const now = Math.floor(Date.now() / 1000)
  const { app, win } = await launchQclod({
    script: {
      steps: [],
      contextPercent: 92,
      rateLimits: { fiveHour: { utilization: 0.95, resetsAt: now + 3600 }, sevenDay: { utilization: 0.85, resetsAt: now + 86400 } },
      remoteControl: { bridge: [{ state: 'reconnecting' }] }
    }
  })
  try {
    // The default window: 1180 wide, the side panel open.
    expect(await win.evaluate(() => window.outerWidth)).toBe(1180)
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()
    const toggle = win.locator('[data-testid="remote-toggle"]')
    await expect(toggle).toBeEnabled({ timeout: 15000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-state', 'reconnecting', { timeout: 15000 })
    await expect(win.locator('[data-testid="status-context-alert"]')).toBeVisible({ timeout: 15000 })
    await expect(win.locator('[data-testid="status-limit-5h-alert"]')).toBeVisible()
    await expect(win.locator('[data-testid="status-limit-7d-alert"]')).toBeVisible()
    await expect(win.locator('[data-testid="side-panel"]')).toBeVisible()

    // One row: every child of the line shares one vertical band, and the line is one row tall.
    const rows = await win.locator('[data-testid="status-line"]').evaluate((line) => {
      const items = [...line.querySelectorAll<HTMLElement>('.status-group > *')].map((e) => e.getBoundingClientRect())
      const tops = items.map((r) => Math.round(r.top + r.height / 2))
      return { spread: Math.max(...tops) - Math.min(...tops), height: line.getBoundingClientRect().height, tallest: Math.max(...items.map((r) => r.height)) }
    })
    expect(rows.spread).toBeLessThanOrEqual(2)
    expect(rows.height).toBeLessThanOrEqual(rows.tallest + 1)
    await shot(win, '11-panel')
  } finally {
    await app.close()
  }
})

/** The rgb() of the category and status colours, read off the page's own tokens. */
const COLOURED = ['--status-ok', '--status-warn', '--status-critical', '--cat-read', '--cat-search', '--cat-edit', '--cat-command', '--cat-agent', '--cat-mcp']

/** Elements whose own words wear a category or status colour. Icons (svg) carry no text and are skipped. */
const wordsInColour = (win: Page) =>
  win.evaluate((names) => {
    const probe = document.createElement('span')
    document.body.append(probe)
    const colours = new Set(names.map((n) => {
      probe.style.color = `var(${n})`
      return getComputedStyle(probe).color
    }))
    probe.remove()
    return [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => !el.closest('svg') && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim() !== ''))
      .filter((el) => colours.has(getComputedStyle(el).color))
      .map((el) => `${el.className || el.tagName}: ${el.textContent!.trim().slice(0, 40)}`)
  }, COLOURED)

test('лента и подагент на графите; ни одно слово не в цвете категории или статуса', async () => {
  const failed = { kind: 'toolError', name: 'Bash', input: { command: 'npm run lint' }, error: 'линтер нашёл 2 проблемы' }
  // The command is slow, so the «now» line can be seen while it runs.
  const slow = ALL_CATEGORIES.map((s) => (s.name === 'Bash' ? { ...s, pauseMs: 2500 } : s))
  const { app, win } = await launchQclod({ script: { steps: [], contextPercent: 92, turns: [[...slow.slice(0, -1), failed, slow.at(-1)]] } })
  try {
    const input = win.locator('[data-testid="composer-input"]')
    await input.fill('Почини вход')
    await input.press('Enter')

    // The «now» line: the chat's own surface, a hairline above, the category rule on the left.
    const now = win.locator('[data-testid="now-line"][data-category="command"]')
    await expect(now).toBeVisible({ timeout: 15000 })
    const nowLook = await now.evaluate((e) => {
      const s = getComputedStyle(e)
      return { bg: s.backgroundColor, top: `${s.borderTopWidth} ${s.borderTopColor}`, rule: s.borderLeftWidth }
    })
    expect(nowLook).toEqual({ bg: 'rgb(22, 22, 26)', top: '1px rgb(38, 38, 45)', rule: '2px' })
    await shot(win, '11-now')

    await expect(win.locator('[data-testid="ribbon-agentText"]').last()).toContainText('Готово', { timeout: 15000 })

    // Cards: raised, bordered, a 2px category rule; the chip a tint mixed into the card itself.
    const card = win.locator('.tool-card[data-category="edit"]').first()
    const look = await card.evaluate((e) => {
      const s = getComputedStyle(e)
      return { bg: s.backgroundColor, border: s.borderTopColor, rule: s.borderLeftWidth }
    })
    expect(look).toEqual({ bg: 'rgb(29, 29, 34)', border: 'rgb(38, 38, 45)', rule: '2px' })
    const chip = await card.locator('.tool-chip').evaluate((e) => getComputedStyle(e).backgroundColor)
    // Opaque: mixed into the card's surface. Chromium reports a mix as `color(srgb r g b)`, with `/ a` only when see-through.
    expect(chip).toMatch(/^color\(srgb [\d.]+ [\d.]+ [\d.]+\)$/)
    await card.locator('.tool-head').hover()
    expect(await card.locator('.tool-head').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(38, 38, 45)')
    await shot(win, '11-ribbon')

    const sub = win.locator('[data-testid="ribbon-subagent"]').first()
    await sub.locator('[data-testid="subagent-head"]').click()
    await expect(sub.locator('.tool-card').first()).toBeVisible()
    await sub.scrollIntoViewIfNeeded()
    await shot(win, '11-subagent')

    expect(await wordsInColour(win)).toEqual([])
  } finally {
    await app.close()
  }
})
