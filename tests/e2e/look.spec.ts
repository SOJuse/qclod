import { test, expect } from '@playwright/test'
import { launchQclod } from './helpers/launch'
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
