/** Waits for a subagent to finish, then sends a typed slash command. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profile = mkdtempSync(join(tmpdir(), 'qclod-fin-'))
const env = { ...process.env }
for (const k of Object.keys(env)) if (k.startsWith('QCLOD_')) delete env[k]
env['QCLOD_USER_DATA'] = profile

const app = await electron.launch({ executablePath: 'dist/win-unpacked/Qclod.exe', args: [], env })
try {
  const win = await app.firstWindow()
  const input = win.locator('[data-testid="composer-input"]')
  await input.waitFor({ timeout: 60000 })

  await input.click()
  await input.fill('Вызови инструмент Agent с subagent_type "Explore" и description "список файлов", задача: назови один любой файл в папке src и всё. Коротко.')
  await input.press('Enter')

  for (let i = 1; i <= 36; i++) {
    await win.waitForTimeout(5000)
    const working = await win.locator('[data-testid="working"]').count()
    const stats = (await win.locator('[data-testid="subagent-stats"]').count())
      ? await win.locator('[data-testid="subagent-stats"]').first().innerText()
      : '—'
    if (i % 3 === 0 || working === 0) console.log(`${i * 5}с: итог=«${stats}»; работает=${working}`)
    if (working === 0 && stats !== '—') break
  }

  const panel = (await win.locator('[data-testid="panel-agents"]').count())
    ? (await win.locator('[data-testid="panel-agents"]').innerText()).replace(/\n/g, ' | ')
    : 'пусто'
  console.log('панель агентов:', panel.slice(0, 160))

  // A slash command typed by hand, not picked from the palette.
  await input.click()
  await input.fill('/compact')
  await input.press('Enter')
  console.log('отправил /compact')

  for (let i = 1; i <= 18; i++) {
    await win.waitForTimeout(5000)
    const compaction = await win.locator('[data-testid="ribbon-compaction"]').count()
    const working = await win.locator('[data-testid="working"]').count()
    const tail = (await win.locator('[data-testid="ribbon"]').innerText()).replace(/\n+/g, ' | ').slice(-160)
    if (i % 2 === 0 || compaction > 0) console.log(`${i * 5}с: сжатий=${compaction}; работает=${working}; хвост=«${tail}»`)
    if (compaction > 0) break
  }
} finally {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
