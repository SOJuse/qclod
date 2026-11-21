import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.env['QCLOD_PACKAGED_EXE']

/**
 * What only a real Mac can show: the application menu, the red button that
 * hides, the Dock icon that brings the window back. Runs in the CI `mac` job
 * on the packaged e2e build (npm run dist:e2e:mac); not headless, so the
 * window's close and activate handlers are the ones a person gets.
 */
test.skip(process.platform !== 'darwin' || !exe, 'нужен macOS и QCLOD_PACKAGED_EXE')

test('меню с «Правка», красная кнопка прячет окно, Dock возвращает его', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-mac-'))
  const app = await electron.launch({
    executablePath: exe,
    args: [],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({ steps: [], nextTurn: [{ kind: 'text', text: 'ok' }] })
    } as Record<string, string>
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 30000 })

    const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label))
    expect(labels).toContain('Правка')
    expect(await win.evaluate(() => document.documentElement.dataset['platform'])).toBe('darwin')
    // The traffic lights are the system's: the bar draws no buttons of its own.
    await expect(win.locator('[data-testid="window-close"]')).toHaveCount(0)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(false)

    await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(true)
  } finally {
    await app.close().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
})
