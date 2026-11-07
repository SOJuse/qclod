/** Opens a real past conversation in the packaged app and reports what shows. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.argv[2] ?? 'dist/win-unpacked/Qclod.exe'
const profile = mkdtempSync(join(tmpdir(), 'qclod-hist-'))
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.startsWith('QCLOD_')) delete env[key]
env['QCLOD_USER_DATA'] = profile

const app = await electron.launch({ executablePath: exe, args: [], env })
try {
  const win = await app.firstWindow()
  win.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)))

  await win.locator('[data-testid="composer-input"]').waitFor({ timeout: 60000 })
  console.log('окно открылось')

  await win.keyboard.press('Control+H')
  const items = win.locator('[data-testid="history-item"]')
  await items.first().waitFor({ timeout: 20000 })
  console.log('сессий в истории:', await items.count())
  console.log('первая:', (await items.first().innerText()).replace(/\n/g, ' | ').slice(0, 120))

  await items.first().click()
  console.log('открыл, жду ленту…')

  for (const wait of [2000, 3000, 5000, 10000, 15000]) {
    await win.waitForTimeout(wait)
    const rows = await win.locator('[data-testid^="ribbon-"]').count()
    const status = await win.locator('[data-testid="tab"]').last().getAttribute('title')
    console.log(`через ~${wait}мс: строк в ленте ${rows}; вкладка: ${String(status).replace(/\n/g, ' / ')}`)
    if (rows > 0) break
  }

  const text = await win.locator('[data-testid="ribbon"]').innerText()
  console.log('лента:', text.replace(/\n/g, ' | ').slice(0, 400) || '(пусто)')
} finally {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
