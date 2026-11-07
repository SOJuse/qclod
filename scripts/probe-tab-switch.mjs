// Diagnostic for the 10-20s freeze when switching tabs.
// Measures how long the renderer's main thread is blocked around a switch,
// and what the pty is told about its size on either side.
//
// Run: node scripts/probe-tab-switch.mjs   (after `npm run build`)
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const profile = mkdtempSync(join(tmpdir(), 'qclod-probe-'))
const projectB = mkdtempSync(join(tmpdir(), 'qclod-probeB-'))
mkdirSync(projectB, { recursive: true })

const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    QCLOD_HEADLESS: '1',
    QCLOD_USER_DATA: profile,
    QCLOD_PICK_FOLDER: projectB,
    QCLOD_AGENT_PATH: process.execPath,
    QCLOD_AGENT_PREFIX_ARGS: JSON.stringify([
      resolve(process.cwd(), 'tests/fixtures/fake-agent/index.js')
    ])
  }
})

const win = await app.firstWindow()
win.on('console', (m) => {
  if (m.text().startsWith('[probe]')) console.log(m.text())
})

await win.locator('[data-testid="tab-strip"]').waitFor()
await win.locator('[data-testid="terminal"]').first().waitFor()

// Watch for long main-thread blocks, the thing the user actually feels.
await win.evaluate(() => {
  const w = window
  w.__blocked = 0
  w.__longest = 0
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      w.__blocked += entry.duration
      w.__longest = Math.max(w.__longest, entry.duration)
    }
  }).observe({ entryTypes: ['longtask'] })

  const originalResize = w.qclod.resize
  w.__resizes = []
  // qclod is frozen by contextBridge, so record from the observable side.
  void originalResize
})

async function fill(lines) {
  const input = win.locator('[data-testid="composer-input"]')
  await input.click()
  await win.keyboard.type(`/spam ${lines}`)
  await win.keyboard.press('Enter')
  await win.locator('[data-testid="terminal"]:not(.is-hidden)').first().waitFor()
  await win.waitForTimeout(3000)
}

console.log('[probe] filling tab 1')
await fill(4000)

console.log('[probe] creating tab 2')
await win.keyboard.press('Control+t')
await win.locator('[data-testid="tab"]').nth(1).waitFor()
await win.waitForTimeout(2000)

console.log('[probe] filling tab 2')
await fill(4000)

const sizesBefore = await win.evaluate(() =>
  [...document.querySelectorAll('[data-testid="terminal"]')].map((el) => ({
    hidden: el.className.includes('is-hidden'),
    w: el.clientWidth,
    h: el.clientHeight,
    rows: el.querySelectorAll('.xterm-rows > div').length
  }))
)
console.log('[probe] terminals before switch:', JSON.stringify(sizesBefore))

await win.evaluate(() => {
  window.__blocked = 0
  window.__longest = 0
})

const started = Date.now()
await win.locator('[data-testid="tab"]').nth(0).click()
// Wait until the switched-to terminal is actually painted.
await win
  .locator('[data-testid="terminal"]:not(.is-hidden) .xterm-rows')
  .first()
  .waitFor({ timeout: 60000 })
const wall = Date.now() - started

const after = await win.evaluate(() => ({
  blocked: Math.round(window.__blocked),
  longest: Math.round(window.__longest)
}))

console.log(`[probe] switch wall time: ${wall} ms`)
console.log(`[probe] main thread blocked: ${after.blocked} ms (longest task ${after.longest} ms)`)

const sizesAfter = await win.evaluate(() =>
  [...document.querySelectorAll('[data-testid="terminal"]')].map((el) => ({
    hidden: el.className.includes('is-hidden'),
    w: el.clientWidth,
    h: el.clientHeight,
    rows: el.querySelectorAll('.xterm-rows > div').length
  }))
)
console.log('[probe] terminals after switch:', JSON.stringify(sizesAfter))

await app.close()
rmSync(profile, { recursive: true, force: true })
rmSync(projectB, { recursive: true, force: true })
