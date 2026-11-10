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
    const loaded = await win.evaluate(() =>
      [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''))
    )
    expect(loaded).toEqual(expect.arrayContaining(['Inter Variable', 'Geist Mono Variable']))

    const remote = await win.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => /\.woff2/.test(n) && !/^(file|http:\/\/localhost)/.test(n))
    )
    expect(remote).toEqual([])
    await shot(win, '03-fonts')
  } finally {
    await app.close()
  }
})
