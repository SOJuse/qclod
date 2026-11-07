// Measures the tab-switch freeze against the REAL Claude Code CLI.
//
// The fake agent ignores SIGWINCH, so it cannot show this at all: the freeze
// comes from the real CLI reflowing its full-screen UI when it is told the
// terminal shrank. No prompt is ever sent and no question is answered — the
// boot screen alone is enough to reflow.
//
// Run: node scripts/probe-tab-switch-real.mjs   (after `npm run build`)
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profile = mkdtempSync(join(tmpdir(), 'qclod-real-'))
const projectB = mkdtempSync(join(tmpdir(), 'qclod-realB-'))

const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    QCLOD_HEADLESS: '1',
    QCLOD_USER_DATA: profile,
    QCLOD_PICK_FOLDER: projectB,
    // No QCLOD_AGENT_PATH: this uses the real `claude` from settings/PATH.
    QCLOD_AGENT_PATH: '',
    QCLOD_AGENT_PREFIX_ARGS: '[]'
  }
})

const win = await app.firstWindow()
await win.locator('[data-testid="tab-strip"]').waitFor()
await win.locator('[data-testid="terminal"]:not(.is-hidden)').first().waitFor()
await win.waitForTimeout(9000) // let the real TUI finish booting

await win.keyboard.press('Control+t')
await win.locator('[data-testid="tab"]').nth(1).waitFor()
await win.waitForTimeout(9000)

await win.evaluate(() => {
  const w = window
  w.__blocked = 0
  w.__longest = 0
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      w.__blocked += e.duration
      w.__longest = Math.max(w.__longest, e.duration)
    }
  }).observe({ entryTypes: ['longtask'] })
})

const results = []
for (let i = 0; i < 4; i++) {
  const target = i % 2
  const started = Date.now()
  await win.locator('[data-testid="tab"]').nth(target).click()
  await win.waitForTimeout(2500) // let any reflow storm land
  results.push(Date.now() - started)
}

const blocked = await win.evaluate(() => ({
  blocked: Math.round(window.__blocked),
  longest: Math.round(window.__longest)
}))

console.log('[real] switches (ms, includes a fixed 2500ms settle):', results.join(', '))
console.log(`[real] main thread blocked across 4 switches: ${blocked.blocked} ms`)
console.log(`[real] longest single blocking task: ${blocked.longest} ms`)

const rows = await win.evaluate(() =>
  [...document.querySelectorAll('[data-testid="terminal"]')].map((el) => ({
    hidden: el.className.includes('is-hidden'),
    rows: el.querySelectorAll('.xterm-rows > div').length
  }))
)
console.log('[real] terminals:', JSON.stringify(rows))

await app.close()
rmSync(profile, { recursive: true, force: true })
rmSync(projectB, { recursive: true, force: true })
