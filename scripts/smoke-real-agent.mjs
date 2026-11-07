/**
 * Drives the PACKAGED app against the REAL agent, once.
 *
 * Deliberately not a test: the suite never talks to the real CLI, by project
 * constraint, so that it stays deterministic, needs no account and spends no
 * tokens. This script is the manual counterpart — the one thing automated
 * tests cannot answer is whether the SDK actually runs inside a packed
 * Electron app, and that is the single largest risk in a release.
 *
 * It asks the agent for one word and costs a fraction of a cent.
 *
 *   node scripts/smoke-real-agent.mjs [path-to-Qclod.exe]
 */

import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.argv[2] ?? 'dist/win-unpacked/Qclod.exe'
const profile = mkdtempSync(join(tmpdir(), 'qclod-smoke-'))

// Everything the fixture uses is stripped: this run must reach the real CLI.
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.startsWith('QCLOD_')) delete env[key]
}
env['QCLOD_USER_DATA'] = profile

const app = await electron.launch({ executablePath: exe, args: [], env })

try {
  const win = await app.firstWindow()
  win.on('pageerror', (error) => console.error('[renderer]', String(error).slice(0, 300)))

  const input = win.locator('[data-testid="composer-input"]')
  await input.waitFor({ timeout: 60000 })
  console.log('окно открылось')

  await input.click()
  await input.fill('Ответь одним словом: привет')
  await input.press('Enter')

  const ribbon = win.locator('[data-testid="ribbon"]')
  const started = Date.now()
  let answered = false

  while (Date.now() - started < 180000) {
    const text = await ribbon.innerText()
    const agent = await win.locator('[data-testid="ribbon-agentText"]').count()
    if (agent > 0) {
      console.log('агент ответил:', text.split('\n').slice(-3).join(' / ').slice(0, 200))
      answered = true
      break
    }
    const notice = await win.locator('[data-testid="ribbon-notice"]').count()
    if (notice > 0) {
      console.error('ошибка в ленте:', (await win.locator('[data-testid="ribbon-notice"]').first().innerText()).slice(0, 300))
      break
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  // The panel is the other half: the numbers only exist if a real session ran.
  const model = await win.locator('[data-testid="panel-model"]').count()
  const limits = await win.locator('[data-testid="panel-limits"]').count()
  console.log(`панель: модель ${model ? 'есть' : 'нет'}, лимиты ${limits ? 'есть' : 'нет'}`)

  console.log(answered ? 'ИТОГ: настоящий агент работает в собранном приложении' : 'ИТОГ: ответа не было')
  process.exitCode = answered ? 0 : 1
} finally {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
