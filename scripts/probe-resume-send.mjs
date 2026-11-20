/** Opens a real past conversation and sends one message. Costs a few cents. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.argv[2] ?? 'dist/win-unpacked/Qclod.exe'
const profile = mkdtempSync(join(tmpdir(), 'qclod-rs-'))
const env = { ...process.env }
for (const k of Object.keys(env)) if (k.startsWith('QCLOD_')) delete env[k]
env['QCLOD_USER_DATA'] = profile

const app = await electron.launch({ executablePath: exe, args: [], env })
try {
  const win = await app.firstWindow()
  win.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)))

  const input = win.locator('[data-testid="composer-input"]')
  await input.waitFor({ timeout: 60000 })

  await win.keyboard.press('Control+H')
  await win.locator('[data-testid="sidebar-session"]').first().waitFor({ timeout: 20000 })
  await win.locator('[data-testid="sidebar-session"]').first().click()
  await win.waitForTimeout(3000)
  console.log('после открытия: строк', await win.locator('[data-testid^="ribbon-"]').count())

  await input.click()
  await input.fill('Ответь ровно одним словом: тест')
  await input.press('Enter')
  console.log('отправил')

  for (let i = 1; i <= 12; i++) {
    await win.waitForTimeout(5000)
    const working = await win.locator('[data-testid="working"]').count()
    const what = working ? await win.locator('[data-testid="working-what"]').innerText() : '—'
    const title = await win.locator('[data-testid="tab"]').first().getAttribute('title')
    const texts = await win.locator('[data-testid="ribbon-agentText"]').count()
    const notices = await win.locator('[data-testid="ribbon-notice"]').count()
    console.log(`${i * 5}с: статус=${String(title).split('\n').pop()}; работает=${working ? what : 'нет'}; ответов=${texts}; ошибок=${notices}`)
    if (notices > 0) {
      console.log('ошибка:', (await win.locator('[data-testid="ribbon-notice"]').last().innerText()).slice(0, 300))
      break
    }
  }

  const tail = await win.locator('[data-testid="ribbon"]').innerText()
  console.log('хвост ленты:', tail.replace(/\n+/g, ' | ').slice(-300))
} finally {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
