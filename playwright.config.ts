import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

// Every e2e run talks to the fake agent, never the real CLI (Global Constraints).
process.env['QCLOD_AGENT_PATH'] = process.execPath
process.env['QCLOD_AGENT_PREFIX_ARGS'] = JSON.stringify([
  resolve(__dirname, 'tests/fixtures/fake-agent/index.js')
])

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: './tests/.artifacts'
})
