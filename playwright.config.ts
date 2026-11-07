import { defineConfig } from '@playwright/test'
import { resolve, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Every e2e run talks to the fake agent, never the real CLI (Global Constraints).
process.env['QCLOD_AGENT_PATH'] = process.execPath
process.env['QCLOD_AGENT_PREFIX_ARGS'] = JSON.stringify([
  resolve(__dirname, 'tests/fixtures/fake-agent/index.js')
])

// A throwaway profile per run: tabs and settings never leak between runs or
// into the developer's real Qclod profile.
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
