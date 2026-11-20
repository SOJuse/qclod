import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchQclod } from './helpers/launch'
import { pasteImage, screenshotPng } from './helpers/clipboard'

/**
 * Task 9: the grey screen. Each case does what the owner did before the window
 * went grey and then checks every channel a broken window would show on:
 * page errors, error boundaries, the error log, the renderer process, and the
 * window's own chrome still being there.
 *
 * A frozen window raises no event of its own: in task 9 a 150 000-char layout
 * freeze never fired `unresponsive`. So each case also times a round trip into
 * the page — a script that forces layout, then the next frame — and requires
 * it under RESPONSIVE_MS, 1 000 ms. Work queued in the page waits for that
 * round trip, so a window still busy laying out fails here.
 */
const RESPONSIVE_MS = 1000

/**
 * Console errors and warnings that are not the window breaking. Each is named
 * here on purpose; anything else fails the case. (None so far: the e2e build
 * prints nothing on these paths.)
 */
const KNOWN_CONSOLE_NOISE: RegExp[] = []

interface Evidence {
  pageErrors: string[]
  consoleErrors: string[]
}

function watch(win: Page): Evidence {
  const ev: Evidence = { pageErrors: [], consoleErrors: [] }
  win.on('pageerror', (err) => ev.pageErrors.push(`${err.message}\n${err.stack ?? ''}`))
  win.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return
    const text = msg.text()
    if (!KNOWN_CONSOLE_NOISE.some((re) => re.test(text))) ev.consoleErrors.push(`${msg.type()}: ${text}`)
  })
  return ev
}

/** The round trip into the page, in ms: script that lays the page out, then a frame. */
async function roundTrip(win: Page): Promise<number> {
  const started = Date.now()
  await win.evaluate(
    () =>
      new Promise<void>((resolve) => {
        void document.body.offsetHeight
        requestAnimationFrame(() => resolve())
      })
  )
  return Date.now() - started
}

interface LogEntry {
  source?: string
  scope?: string
  message?: string
}

/**
 * What in userData/logs/qclod.log says the window broke: any report from the
 * renderer (a render error, a handler error), and main's notes about the
 * renderer process (render-process-gone, unresponsive). A line that is
 * neither, or not JSON, is not a failure.
 */
function brokenWindowEntries(log: string): LogEntry[] {
  const entries: LogEntry[] = []
  for (const line of log.split('\n')) {
    if (line.trim() === '') continue
    let entry: LogEntry
    try {
      entry = JSON.parse(line) as LogEntry
    } catch {
      continue
    }
    const fromRenderer = entry.source === 'renderer'
    const aboutRenderer = entry.scope === 'window' || /render-process|unresponsive/.test(entry.message ?? '')
    if (fromRenderer || aboutRenderer) entries.push(entry)
  }
  return entries
}

async function watchProcess(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as { __greyGone?: string[] }
    g.__greyGone = []
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    wc.on('render-process-gone', (_e, d) => g.__greyGone!.push(`${d.reason}:${d.exitCode}`))
    wc.on('unresponsive', () => g.__greyGone!.push('unresponsive'))
  })
}

async function expectAlive(app: ElectronApplication, win: Page, profile: string, ev: Evidence): Promise<void> {
  await expect(win.locator('[data-testid="title-bar"]')).toBeVisible()
  await expect(win.locator('[data-testid="composer-input"]')).toBeVisible()
  await expect(win.locator('[data-testid^="error-boundary-"]')).toHaveCount(0)
  expect(await roundTrip(win), `round trip into the page, ms (limit ${RESPONSIVE_MS})`).toBeLessThan(RESPONSIVE_MS)
  // Read after the round trip: whatever the page reported before it has reached main.
  const gone = await app.evaluate(() => (globalThis as { __greyGone?: string[] }).__greyGone ?? [])
  const logFile = join(profile, 'logs', 'qclod.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  expect(ev.pageErrors, 'page errors').toEqual([])
  expect(ev.consoleErrors, 'console errors and warnings').toEqual([])
  expect(gone, 'renderer process events').toEqual([])
  expect(brokenWindowEntries(log), `userData/logs/qclod.log:\n${log}`).toEqual([])
}

const input = (win: Page) => win.locator('[data-testid="composer-input"]')

/**
 * Ctrl+V of text without the system clipboard: the paste event (our handler),
 * then the insertion a paste does — ReplaceSelectionCommand, which
 * webContents.replace runs too. (keyboard.insertText takes another path,
 * quadratic in the number of lines: minutes for 200 000 chars.)
 */
async function pasteText(app: ElectronApplication, win: Page, text: string): Promise<void> {
  await input(win).click()
  const handled = await input(win).evaluate((el, t) => {
    const data = new DataTransfer()
    data.setData('text/plain', t)
    const e = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    el.dispatchEvent(e)
    return e.defaultPrevented
  }, text)
  if (handled) return
  await app.evaluate(({ BrowserWindow }, t) => BrowserWindow.getAllWindows()[0]!.webContents.replace(t), text)
}

/** A file copied in Explorer: a File with a real path, as webUtils sees it. */
async function pasteFiles(win: Page, paths: string[], withImage?: string): Promise<void> {
  await input(win).click()
  await win.evaluate(() => {
    const el = document.createElement('input')
    el.type = 'file'
    el.multiple = true
    el.id = '__grey_files'
    el.style.display = 'none'
    document.body.appendChild(el)
  })
  await win.setInputFiles('#__grey_files', paths)
  await input(win).evaluate((field, b64) => {
    const picker = document.getElementById('__grey_files') as HTMLInputElement
    const data = new DataTransfer()
    for (const f of Array.from(picker.files ?? [])) data.items.add(f)
    if (b64) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    }
    picker.remove()
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, withImage ?? '')
}

const SLOW = {
  steps: [],
  turns: [[{ kind: 'textStream', pieces: ['думаю ', 'ещё ', 'немного ', 'и ещё ', 'готово'], pauseMs: 900 }]],
  nextTurn: [{ kind: 'text', text: 'дальше' }]
}

test('вставка текста 200 000 символов', async () => {
  const { app, win, profile } = await launchQclod({ script: { steps: [], nextTurn: [{ kind: 'text', text: 'ок' }] } })
  const ev = watch(win)
  try {
    await watchProcess(app)
    // A log or a listing, as people paste it: lines, Cyrillic, paths. One
    // 200 000-char paragraph of Russian with no line break is a different
    // case — Blink lays it out in quadratic time (grey-screen.md) — and is
    // left out so the suite does not sit through a 20-second freeze.
    const line = 'строка с путём src/main/index.ts и C:\\dev\\q1b\\README.md\n'
    const big = line.repeat(Math.ceil(200_000 / line.length)).slice(0, 200_000)
    await pasteText(app, win, big)
    expect(await input(win).inputValue()).toBe(big)
    await input(win).press('Enter')
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(1, { timeout: 20000 })
    await expect(win.getByText('ок', { exact: true })).toBeVisible({ timeout: 20000 })
    await input(win).press('ArrowUp')
    expect(await input(win).inputValue()).toBe(big)
    await win.waitForTimeout(1000)
    await expectAlive(app, win, profile, ev)
  } finally {
    await app.close()
  }
})

test('вставка картинки, затем файла из проводника, затем смешанный буфер', async () => {
  const { app, win, profile } = await launchQclod({ script: { steps: [], nextTurn: [{ kind: 'reportInput' }] } })
  const ev = watch(win)
  try {
    await watchProcess(app)
    const png = await screenshotPng(app, 1600, 1000)
    await pasteImage(win, png)
    await expect(win.locator('[data-testid="composer-chip-thumb"]')).toBeVisible({ timeout: 15000 })
    const file = join(profile, 'заметка.txt')
    writeFileSync(file, 'привет')
    await pasteFiles(win, [file])
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(2)
    await pasteFiles(win, [file], png)
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(3, { timeout: 15000 })
    await input(win).fill('что тут?')
    await input(win).press('Enter')
    await expect(win.locator('[data-testid="ribbon"]')).toContainText('картинок:', { timeout: 15000 })
    await win.waitForTimeout(1000)
    await expectAlive(app, win, profile, ev)
  } finally {
    await app.close()
  }
})

test('«Стоп» с очередью из 3 сообщений с картинкой', async () => {
  const { app, win, profile } = await launchQclod({ script: SLOW })
  const ev = watch(win)
  try {
    await watchProcess(app)
    const png = await screenshotPng(app, 800, 600)
    await input(win).click()
    await input(win).fill('первое')
    await input(win).press('Enter')
    await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 15000 })
    for (const text of ['второе', 'третье', 'четвёртое']) {
      await pasteImage(win, png)
      await expect(win.locator('[data-testid="composer-chip-thumb"]')).toBeVisible({ timeout: 15000 })
      await input(win).fill(text)
      await input(win).press('Enter')
      await expect(input(win)).toHaveValue('')
    }
    await expect(win.locator('[data-testid="queue-item"]')).toHaveCount(3)
    await win.locator('[data-testid="composer-stop"]').click()
    await expect(input(win)).toHaveValue('второе\n\nтретье\n\nчетвёртое', { timeout: 10000 })
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(3)
    await expect(win.locator('[data-testid="composer-chip-thumb"]')).toHaveCount(3)
    // And it all goes again.
    await input(win).press('Enter')
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(2, { timeout: 15000 })
    await win.waitForTimeout(1000)
    await expectAlive(app, win, profile, ev)
  } finally {
    await app.close()
  }
})

test('«Стоп» сразу после вставки картинки, пока она готовится', async () => {
  const { app, win, profile } = await launchQclod({ script: SLOW, env: { QCLOD_PREPARE_DELAY_MS: '2000' } })
  const ev = watch(win)
  try {
    await watchProcess(app)
    const png = await screenshotPng(app, 800, 600)
    await input(win).click()
    await input(win).fill('первое')
    await input(win).press('Enter')
    await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 15000 })
    await pasteImage(win, png)
    await input(win).fill('с картинкой')
    // Enter waits for the picture; Esc stops the turn while it is still being made.
    await input(win).press('Enter')
    await expect(win.locator('[data-testid="composer-chip-thumb"]')).toHaveCount(0)
    await input(win).press('Escape')
    await expect(win.locator('[data-testid="composer-send"]')).toBeVisible({ timeout: 10000 })
    // The picture is ready later and the waiting message goes, with it.
    const bubbles = win.locator('[data-testid="ribbon-user"]')
    await expect(bubbles).toHaveCount(2, { timeout: 15000 })
    await expect(bubbles.nth(1)).toContainText('с картинкой')
    await expect(bubbles.nth(1).locator('[data-testid="row-user-image"]')).toBeVisible()
    await expect(win.locator('[data-testid="composer-chip"]')).toHaveCount(0)
    await win.waitForTimeout(1000)
    await expectAlive(app, win, profile, ev)
  } finally {
    await app.close()
  }
})
