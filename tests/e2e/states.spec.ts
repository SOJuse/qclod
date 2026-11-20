import { test, expect, type ElectronApplication, type Locator } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchQclod } from './helpers/launch'
import { shot } from './helpers/shot'

/**
 * Loading, empty and error states of every screen that waits on the main
 * process. The waits and refusals come from the IPC fault seam
 * (QCLOD_FAKE_SLOW / QCLOD_FAKE_FAIL / QCLOD_FAKE_FAIL_TIMES).
 */

/** Loading fades in after a short delay, so a fast answer never flashes it; wait it out before a shot. */
async function shownAfterDelay(loading: Locator): Promise<void> {
  await expect(loading).toHaveCSS('opacity', '1')
}

const HISTORY = JSON.stringify({
  sessions: [
    { sessionId: 's-1', summary: 'Починка вставки файлов', lastModified: Date.now(), firstPrompt: 'вставка не работает' }
  ],
  messages: {}
})

test('история: загрузка, затем ошибка с причиной и «Повторить»', async () => {
  const { app, win } = await launchQclod({
    env: {
      QCLOD_FAKE_HISTORY: HISTORY,
      QCLOD_FAKE_SLOW: '{"history:list":1500}',
      QCLOD_FAKE_FAIL: '{"history:list":"нет доступа"}'
    }
  })
  try {
    await win.keyboard.press('Control+H')
    const loading = win.locator('[data-testid="history-screen"] [data-state="loading"]')
    await expect(loading).toContainText('Читаю историю…')
    await expect(loading).toHaveAttribute('role', 'status')
    await shownAfterDelay(loading)
    await shot(win, '09-history-loading')

    const err = win.locator('[data-testid="history-screen"] [data-state="error"]')
    await expect(err).toContainText('Не удалось прочитать историю', { timeout: 10000 })
    await expect(err).toContainText('нет доступа')
    // Electron's wrapping of the main side's message is not shown.
    await expect(err).not.toContainText('Error invoking remote method')
    await expect(err).toHaveAttribute('role', 'alert')
    await expect(err.getByRole('button', { name: 'Повторить' })).toBeVisible()
    await shot(win, '09-history-error')
  } finally {
    await app.close()
  }
})

test('история: «Повторить» читает заново и показывает список', async () => {
  // The empty tab reads the history once by itself; the screen's first read fails too.
  const { app, win } = await launchQclod({
    env: {
      QCLOD_FAKE_HISTORY: HISTORY,
      QCLOD_FAKE_FAIL: '{"history:list":"нет доступа"}',
      QCLOD_FAKE_FAIL_TIMES: '{"history:list":2}'
    }
  })
  try {
    await expect(win.locator('[data-testid="empty-tab"]')).toBeVisible({ timeout: 15000 })
    await win.keyboard.press('Control+H')
    const err = win.locator('[data-testid="history-screen"] [data-state="error"]')
    await expect(err).toBeVisible()
    await err.getByRole('button', { name: 'Повторить' }).click()
    await expect(win.locator('[data-testid="history-item"]')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('история: поиск без совпадений называет запрос', async () => {
  const { app, win } = await launchQclod({ env: { QCLOD_FAKE_HISTORY: HISTORY } })
  try {
    await win.keyboard.press('Control+H')
    await expect(win.locator('[data-testid="history-item"]')).toHaveCount(1)
    await win.locator('[data-testid="history-query"]').fill('zzz')
    const empty = win.locator('[data-testid="history-screen"] [data-state="empty"]')
    await expect(empty).toContainText('Ничего не нашлось по «zzz»')
    await shot(win, '09-history-no-match')
  } finally {
    await app.close()
  }
})

test('настройки открываются сразу и показывают загрузку', async () => {
  const { app, win } = await launchQclod({ env: { QCLOD_FAKE_SLOW: '{"settings:get":3000}' } })
  try {
    await win.locator('[data-testid="open-settings"]').click()
    const sheet = win.locator('[data-testid="settings"]')
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('[data-state="loading"]')).toContainText('Загружаю настройки…')
    await shownAfterDelay(sheet.locator('[data-state="loading"]'))
    await shot(win, '09-settings-loading')
    await expect(win.locator('[data-testid="setting-globalHotkey"]')).toBeVisible({ timeout: 10000 })
    await expect(sheet.locator('[data-state="loading"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('вкладки и версия не прочитались при старте — окно не роняет необработанных ошибок', async () => {
  const { app, win } = await launchQclod({
    env: { QCLOD_FAKE_FAIL: '{"app:version":"нет ответа"}' }
  })
  try {
    // The tabs reach the window only through the read and its retry: their push
    // is held back, and the first read after a reload fails once. A handler on
    // the window's own ipc goes before ipcMain's; it takes itself away when hit,
    // so the next read reaches the real one.
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents
      const send = wc.send.bind(wc)
      wc.send = (channel: string, ...args: unknown[]): void => {
        if (channel !== 'tabs:changed') send(channel, ...args)
      }
      const seen = globalThis as { __qclodTabsFailed?: number }
      seen.__qclodTabsFailed = 0
      wc.ipc.handle('tabs:list', () => {
        seen.__qclodTabsFailed = (seen.__qclodTabsFailed ?? 0) + 1
        wc.ipc.removeHandler('tabs:list')
        throw new Error('нет ответа')
      })
    })
    const errors: string[] = []
    win.on('pageerror', (err) => errors.push(err.message))
    await win.reload()
    // The first read failed; only the retry can bring the tab.
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(1, { timeout: 15000 })
    expect(
      await app.evaluate(() => (globalThis as { __qclodTabsFailed?: number }).__qclodTabsFailed)
    ).toBe(1)
    await win.locator('[data-testid="open-settings"]').click()
    await expect(win.locator('[data-testid="settings"]')).toBeVisible()
    // An unknown version is left out, not printed as a gap.
    await expect(win.locator('.settings-version')).toHaveText(/^Qclod · /)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('настройки не прочитались — ошибка и «Повторить»', async () => {
  const { app, win } = await launchQclod({
    env: { QCLOD_FAKE_FAIL: '{"settings:get":"файл занят"}', QCLOD_FAKE_FAIL_TIMES: '{"settings:get":1}' }
  })
  try {
    await win.locator('[data-testid="open-settings"]').click()
    const err = win.locator('[data-testid="settings"] [data-state="error"]')
    await expect(err).toContainText('Не удалось прочитать настройки')
    await expect(err).toContainText('файл занят')
    await err.getByRole('button', { name: 'Повторить' }).click()
    await expect(win.locator('[data-testid="setting-globalHotkey"]')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('настройки: хоткей и правила не прочитались — ошибка в своём разделе', async () => {
  const { app, win } = await launchQclod({
    env: {
      QCLOD_FAKE_FAIL: '{"hotkey:status":"нет ответа","permission:rules":"хранилище закрыто"}',
      QCLOD_FAKE_FAIL_TIMES: '{"permission:rules":1}'
    }
  })
  try {
    await win.locator('[data-testid="open-settings"]').click()
    const hotkey = win.locator('[data-testid="hotkey-status-error"]')
    await expect(hotkey).toContainText('Не удалось проверить сочетание')
    await expect(hotkey).toContainText('нет ответа')
    await expect(hotkey.getByRole('button', { name: 'Повторить' })).toBeVisible()

    const rules = win.locator('[data-testid="rules-error"]')
    await expect(rules).toContainText('Не удалось прочитать правила')
    await expect(rules).toContainText('хранилище закрыто')
    await shot(win, '09-settings-section-errors')
    await rules.getByRole('button', { name: 'Повторить' }).click()
    await expect(win.locator('[data-testid="rules-empty"]')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('настройки: сохранение упало — «Не сохранилось» на месте «Сохранено»', async () => {
  const { app, win } = await launchQclod({ env: { QCLOD_FAKE_FAIL: '{"settings:set":"диск полон"}' } })
  try {
    await win.locator('[data-testid="open-settings"]').click()
    await win.locator('[data-testid="setting-soundEnabled"]').click()
    const failed = win.locator('[data-testid="settings-save-failed"]')
    await expect(failed).toHaveText('Не сохранилось: диск полон')
    // The reason reads in text colour (--text); red stays on the icon.
    await expect(failed).toHaveCSS('color', 'rgb(236, 236, 241)')
    await expect(win.locator('[data-testid="settings-saved"]')).toHaveCount(0)
    await shot(win, '09-settings-save-failed')
  } finally {
    await app.close()
  }
})

test('лента грузится — «Загружаю разговор…»', async () => {
  const { app, win } = await launchQclod({ env: { QCLOD_FAKE_SLOW: '{"agent:ribbon":3000}' } })
  try {
    const loading = win.locator('[data-testid="chat-pane"] [data-state="loading"]')
    await expect(loading).toContainText('Загружаю разговор…')
    await shownAfterDelay(loading)
    await shot(win, '09-ribbon-loading')
    await expect(win.locator('[data-testid="empty-tab"]')).toBeVisible({ timeout: 10000 })
  } finally {
    await app.close()
  }
})

test('лента не загрузилась — ошибка и «Повторить» вместо пустоты', async () => {
  const { app, win } = await launchQclod({
    env: { QCLOD_FAKE_FAIL: '{"agent:ribbon":"сессия занята"}', QCLOD_FAKE_FAIL_TIMES: '{"agent:ribbon":1}' }
  })
  try {
    const err = win.locator('[data-testid="chat-pane"] [data-state="error"]')
    await expect(err).toContainText('Не удалось загрузить разговор')
    await expect(err).toContainText('сессия занята')
    await expect(win.locator('[data-testid="empty-tab"]')).toHaveCount(0)
    await shot(win, '09-ribbon-error')
    await err.getByRole('button', { name: 'Повторить' }).click()
    await expect(win.locator('[data-testid="empty-tab"]')).toBeVisible()
    await expect(err).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('панель без данных — «Появится после первого ответа», агентов — «Агентов нет»', async () => {
  const { app, win } = await launchQclod({ script: { steps: [] } })
  try {
    const panel = win.locator('[data-testid="side-panel"]')
    await expect(panel).toBeVisible({ timeout: 15000 })
    await expect(panel.locator('[data-testid="panel-empty"]').first()).toContainText('Появится после первого ответа')
    await expect(panel.locator('[data-testid="panel-empty"]', { hasText: 'Агентов нет' })).toHaveCount(1)
    await shot(win, '09-panel-empty')
  } finally {
    await app.close()
  }
})

test('палитра Ctrl+K: ничего не нашлось', async () => {
  const { app, win } = await launchQclod()
  try {
    await win.keyboard.press('Control+K')
    await win.locator('[data-testid="action-query"]').fill('zzzz')
    const empty = win.locator('[data-testid="action-palette"] [data-state="empty"]')
    await expect(empty).toContainText('Такого действия нет')
    await shot(win, '09-palette-empty')
  } finally {
    await app.close()
  }
})

/**
 * A profile whose agent path names a file that is not there: the setup screen.
 * The launcher keeps a profile it was given, so the spec removes it.
 */
const profiles: string[] = []
test.afterEach(() => {
  for (const dir of profiles.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})
function missingAgentProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-states-'))
  profiles.push(profile)
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ agentPath: join(profile, 'нет', 'claude.exe') }))
  return profile
}

test('установка: «Проверить снова» — «Проверяю…», кнопка неактивна', async () => {
  const { app, win } = await launchQclod({
    env: {
      QCLOD_USER_DATA: missingAgentProfile(),
      QCLOD_FAKE_INSTALL: JSON.stringify({ methods: ['winget'], results: [] }),
      QCLOD_FAKE_SLOW: '{"setup:check":1500}'
    }
  })
  try {
    await expect(win.locator('[data-testid="setup-screen"]')).toBeVisible({ timeout: 15000 })
    const recheck = win.locator('[data-testid="setup-recheck"]')
    await recheck.click()
    await expect(recheck).toHaveText('Проверяю…')
    await expect(recheck).toBeDisabled()
    await shot(win, '09-setup-checking')
    await expect(recheck).toHaveText('Проверить снова', { timeout: 10000 })
    await expect(recheck).toBeEnabled()
  } finally {
    await app.close()
  }
})

test('установка не удалась — журнал виден и можно повторить', async () => {
  const { app, win } = await launchQclod({
    env: {
      QCLOD_USER_DATA: missingAgentProfile(),
      QCLOD_FAKE_INSTALL: JSON.stringify({ methods: ['winget'], results: [false] })
    }
  })
  try {
    await win.locator('[data-testid="setup-install"]').click({ timeout: 15000 })
    const step = win.locator('[data-testid="setup-step-agent"]')
    await expect(step).toContainText('Установить не получилось.')
    await expect(win.locator('[data-testid="setup-log"]')).toBeVisible()
    await expect(win.locator('[data-testid="setup-install"]')).toHaveText('Попробовать снова')
    await shot(win, '09-setup-install-failed')
  } finally {
    await app.close()
  }
})

test('ошибка отрисовки панели не гасит окно — вторая панель живая', async () => {
  const other = mkdtempSync(join(tmpdir(), 'qclod-boundary-'))
  const { app, win } = await launchQclod({
    env: { QCLOD_E2E_THROW_IN_PANE: '1', QCLOD_PICK_FOLDER: other }
  })
  try {
    await win.locator('[data-testid="tab-new"]').click()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })
    await win.locator('[data-testid="toggle-split"]').click()

    // The first pane threw while drawing; only it is replaced.
    await expect(win.getByRole('button', { name: 'Перезагрузить панель' })).toBeVisible()
    await expect(win.getByText('В этой панели что-то сломалось')).toBeVisible()
    // The other pane of the split is alive.
    await expect(win.locator('[data-testid="chat-pane"]')).toHaveCount(1)
    await expect(win.locator('[data-testid="chat-pane"] [data-testid="composer-input"]')).toBeVisible()
  } finally {
    await app.close()
    rmSync(other, { recursive: true, force: true })
  }
})

/**
 * The window that will not start (task 17). Runs in the page through main:
 * after a renderer crash Playwright's Page is gone for good, while the
 * webContents lives on with whatever page was loaded next.
 */
function inPageOf<T>(app: ElectronApplication, code: string): Promise<T> {
  return app.evaluate(
    ({ BrowserWindow }, js) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(js),
    code
  ) as Promise<T>
}
const present = (testid: string): string => `document.querySelector('[data-testid="${testid}"]') !== null`

/** Saves what the window shows now, taken by main, so it works with no Page left. */
async function shotFromMain(app: ElectronApplication, name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return image.toPNG().toString('base64')
  })
  const dir = process.env['QCLOD_SHOT_DIR'] ?? 'tests/.artifacts/shots'
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name + '.png'), Buffer.from(png, 'base64'))
}

test('окно упало четыре раза: заглушка со способом выйти, «Попробовать снова» возвращает окно', async () => {
  test.setTimeout(90_000)
  const { app, profile } = await launchQclod()
  try {
    // Crashed from outside, as a real renderer crash would be: no test seam is involved.
    // The first three are reloaded; the fourth leaves the static page.
    for (let i = 0; i < 4; i++) {
      await app.evaluate(
        ({ BrowserWindow }) =>
          new Promise<void>((resolve) => {
            const contents = BrowserWindow.getAllWindows()[0]!.webContents
            contents.once('did-finish-load', () => resolve())
            contents.forcefullyCrashRenderer()
          })
      )
    }
    await expect.poll(() => inPageOf(app, present('fallback-retry')), { timeout: 15_000 }).toBe(true)
    expect(await inPageOf(app, present('fallback-logs'))).toBe(true)
    expect(await inPageOf(app, present('fallback-close'))).toBe(true)
    expect(await inPageOf(app, `document.querySelector('h1').textContent`)).toBe('Окно Qclod не запускается')
    expect(await inPageOf(app, `document.querySelector('.fb-text').textContent`)).toContain('Окно трижды перезагрузилось и снова упало.')
    // The page is the static one: nothing of the app is in it.
    expect(await inPageOf(app, present('app-root'))).toBe(false)
    await shotFromMain(app, '17-fallback')

    // It was written down why.
    const log = readFileSync(join(profile, 'logs', 'qclod.log'), 'utf8')
    expect(log).toContain('giving up')

    await inPageOf(app, `document.querySelector('[data-testid="fallback-retry"]').click()`)
    await expect.poll(() => inPageOf(app, present('app-root')).catch(() => false), { timeout: 15_000 }).toBe(true)
    expect(await inPageOf(app, present('fallback-retry'))).toBe(false)
  } finally {
    await app.close()
  }
})

test('сборка окна не загрузилась: после ожидания та же заглушка, а не вечная заставка', async () => {
  test.setTimeout(90_000)
  // QCLOD_MOUNT_MS shortens the 15 s wait for the first screen.
  const { app, profile } = await launchQclod({ env: { QCLOD_MOUNT_MS: '5000' } })
  try {
    // The script of the window cannot be fetched: the page loads, createRoot never runs.
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      contents.session.webRequest.onBeforeRequest({ urls: ['*://*/*.js', 'file:///*.js'] }, (details, callback) =>
        callback({ cancel: /\/assets\/index-[^/]*\.js$/.test(details.url) })
      )
      contents.reload()
    })
    await expect
      .poll(() => inPageOf(app, present('boot')).catch(() => null), { timeout: 5_000 })
      .toBe(true)
    await expect.poll(() => inPageOf(app, present('fallback-retry')), { timeout: 20_000 }).toBe(true)
    expect(readFileSync(join(profile, 'logs', 'qclod.log'), 'utf8')).toContain('did not mount')
    // It says what happened: the window did not open, not that it crashed three times.
    expect(await inPageOf(app, `document.querySelector('.fb-text').textContent`)).toContain('Окно не открылось за 15 секунд.')

    // The bundle is back: «Попробовать снова» loads the window.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.session.webRequest.onBeforeRequest(null))
    await inPageOf(app, `document.querySelector('[data-testid="fallback-retry"]').click()`)
    await expect.poll(() => inPageOf(app, present('app-root')).catch(() => false), { timeout: 15_000 }).toBe(true)
  } finally {
    await app.close()
  }
})
