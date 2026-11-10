import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface LaunchOptions {
  script?: unknown
  env?: Record<string, string>
  size?: { width: number; height: number }
}

/** Starts Qclod against the fake SDK with a fresh profile. Never the real agent. */
export async function launchQclod(
  opts: LaunchOptions = {}
): Promise<{ app: ElectronApplication; win: Page; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-e2e-'))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    QCLOD_FAKE_SDK: resolve(__dirname, '../../fixtures/fake-sdk/index.mjs'),
    QCLOD_HEADLESS: '1',
    QCLOD_USER_DATA: profile,
    ...(opts.script === undefined ? {} : { QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(opts.script) }),
    ...opts.env
  }
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  if (opts.size) {
    await app.evaluate(
      ({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s.width, s.height),
      opts.size
    )
  }
  await win.waitForSelector('[data-testid="composer-input"], [data-testid="setup-screen"]', { timeout: 15000 })
  return { app, win, profile }
}
