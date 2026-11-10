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
  } finally {
    await app.close()
  }
})
