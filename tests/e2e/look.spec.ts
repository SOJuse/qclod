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
