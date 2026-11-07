/** Runs a real subagent and a real slash command, and reports what the UI shows. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profile = mkdtempSync(join(tmpdir(), 'qclod-sa-'))
const env = { ...process.env }
for (const k of Object.keys(env)) if (k.startsWith('QCLOD_')) delete env[k]
env['QCLOD_USER_DATA'] = profile

const app = await electron.launch({ executablePath: 'dist/win-unpacked/Qclod.exe', args: [], env })
try {
  const win = await app.firstWindow()
  const input = win.locator('[data-testid="composer-input"]')
  await input.waitFor({ timeout: 60000 })

  await input.click()
  await input.fill('Запусти подагента Explore с задачей: посчитай сколько файлов .ts в папке src. Используй инструмент Agent.')
  await input.press('Enter')
  console.log('отправил задачу для подагента')

  for (let i = 1; i <= 24; i++) {
    await win.waitForTimeout(5000)
    const cards = await win.locator('[data-testid="ribbon-subagent"]').count()
    const stats = cards ? await win.locator('[data-testid="subagent-stats"]').first().innerText() : '—'
    const panel = await win.locator('[data-testid="panel-agents"]').count()
    const panelText = panel ? (await win.locator('[data-testid="panel-agents"]').innerText()).replace(/\n/g, ' | ') : 'пусто'
    const working = await win.locator('[data-testid="working"]').count()
    console.log(`${i * 5}с: карточек=${cards}; итог=«${stats}»; панель=«${panelText.slice(0, 90)}»; работает=${working}`)
    if (cards > 0 && working === 0) break
  }

  // And a slash command, the way a person types it.
  await input.click()
  await input.press('/')
  const palette = await win.locator('[data-testid="command-palette"]').count()
  console.log('палитра по «/»:', palette)
  if (palette) {
    await win.locator('[data-testid="palette-query"]').fill('compact')
    const first = await win.locator('[data-testid="palette-item"]').first().innerText()
    console.log('первый пункт:', first.replace(/\n/g, ' | ').slice(0, 80))
    await win.keyboard.press('Escape')
  }
  await input.fill('/compact')
  console.log('в поле:', await input.inputValue())
} finally {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
