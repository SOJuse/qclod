import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.env['QCLOD_PACKAGED_EXE']

/**
 * Runs the real packaged build rather than `electron .`, which is the only way
 * to catch problems that exist only after packaging: files missing from the
 * asar, and the hook helper being unreachable inside it.
 *
 * Enable with: QCLOD_PACKAGED_EXE=dist/win-unpacked/Qclod.exe
 */
test.skip(!exe, 'задать QCLOD_PACKAGED_EXE, чтобы проверить собранное приложение')

test('собранное приложение запускается, агент отвечает, хук доходит', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-packaged-'))
  const app = await electron.launch({
    executablePath: exe,
    args: [],
    env: { ...process.env, QCLOD_USER_DATA: profile, QCLOD_HEADLESS: '1' } as Record<string, string>
  })

  try {
    const win = await app.firstWindow()
    const terminal = win.locator('[data-testid="terminal"]').first()
    await expect(terminal).toContainText('fake-agent ready', { timeout: 30000 })

    await win.locator('[data-testid="composer-input"]').click()
    await win.keyboard.type('проверка сборки')
    await win.keyboard.press('Enter')
    await expect(terminal).toContainText('[submit 1]', { timeout: 20000 })

    // Proves bin/qclod-hook.js is reachable outside the asar archive.
    const dot = win.locator('[data-testid="tab"] .tab-status').first()
    await expect(dot).toHaveClass(/is-idle/, { timeout: 20000 })
  } finally {
    await app.close().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
})
