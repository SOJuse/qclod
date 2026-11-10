import { defineConfig } from '@playwright/test'
import { resolve, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Every e2e run talks to the fake SDK, never the real agent (Global Constraints).
process.env['QCLOD_FAKE_SDK'] = resolve(__dirname, 'tests/fixtures/fake-sdk/index.mjs')

// A throwaway profile per run: tabs and settings never leak between runs or
// into the developer's real Qclod profile.
process.env['QCLOD_HEADLESS'] = '1'
// The window opens off screen and never takes focus, so the machine stays
// usable while the suite runs (src/main/window.ts).
process.env['QCLOD_E2E_INVISIBLE'] = '1'
process.env['QCLOD_USER_DATA'] = mkdtempSync(join(tmpdir(), 'qclod-e2e-'))

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: './tests/.artifacts'
})
