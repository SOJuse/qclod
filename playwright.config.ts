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
// (A Mac gives an off-screen window back to the screen, so there the run is visible.)
if (process.platform !== 'darwin') process.env['QCLOD_E2E_INVISIBLE'] = '1'
// The runner makes it once; its workers load this file again and inherit the
// runner's environment, so they use the same folder. globalTeardown deletes it
// when the run ends (Ruling M2).
process.env['QCLOD_E2E_PROFILE'] ??= mkdtempSync(join(tmpdir(), 'qclod-e2e-'))
process.env['QCLOD_USER_DATA'] = process.env['QCLOD_E2E_PROFILE']
// Claude Code's own folder (transcripts, commands, settings) is a throwaway one
// too: no spec reads or writes the owner's real ~/.claude. A spec that needs
// transcripts passes its own CLAUDE_CONFIG_DIR per launch.
process.env['QCLOD_E2E_CLAUDE_CONFIG'] ??= mkdtempSync(join(tmpdir(), 'qclod-e2e-claude-'))
process.env['CLAUDE_CONFIG_DIR'] = process.env['QCLOD_E2E_CLAUDE_CONFIG']


// The real `claude auth status` is never asked in e2e: by default the agent
// counts as logged in. A spec overrides it per launch through `env`.
process.env['QCLOD_FAKE_AUTH'] ??= '{"sequence":["in"]}'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalTeardown: './tests/e2e/helpers/globalTeardown.ts',
  outputDir: './tests/.artifacts'
})
