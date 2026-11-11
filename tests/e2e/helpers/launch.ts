import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../..')
const FAKE_SDK = resolve(REPO_ROOT, 'tests/fixtures/fake-sdk/index.mjs')
const MIN_SIZE = { width: 800, height: 600 }

export interface LaunchOptions {
  /** Scripted fake-SDK run; passed to the app JSON-stringified as QCLOD_FAKE_SDK_SCRIPT. */
  script?: unknown
  /** Extra env. QCLOD_FAKE_SDK is not allowed here; QCLOD_USER_DATA, if given, is the caller's own profile and is not deleted. */
  env?: Record<string, string>
  size?: { width: number; height: number }
}

/**
 * Starts Qclod against the fake SDK with a fresh profile. Never the real agent.
 * Closing the returned app also removes the temporary profile.
 */
export async function launchQclod(
  opts: LaunchOptions = {}
): Promise<{ app: ElectronApplication; win: Page; profile: string }> {
  const extra = opts.env ?? {}
  if ('QCLOD_FAKE_SDK' in extra) throw new Error('launchQclod: QCLOD_FAKE_SDK is fixed to the fake SDK')
  if (!existsSync(FAKE_SDK)) throw new Error(`launchQclod: fake SDK missing at ${FAKE_SDK}`)
  if (opts.size && (opts.size.width < MIN_SIZE.width || opts.size.height < MIN_SIZE.height)) {
    throw new Error(`launchQclod: size is below the window minimum ${MIN_SIZE.width}x${MIN_SIZE.height}`)
  }

  const ownProfile = extra['QCLOD_USER_DATA'] === undefined
  const profile = extra['QCLOD_USER_DATA'] ?? mkdtempSync(join(tmpdir(), 'qclod-e2e-'))
  const removeProfile = (): void => {
    if (ownProfile) rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...extra }
  delete env['QCLOD_FAKE_SDK_SCRIPT']
  if (opts.script !== undefined) env['QCLOD_FAKE_SDK_SCRIPT'] = JSON.stringify(opts.script)
  env['QCLOD_FAKE_SDK'] = FAKE_SDK
  env['QCLOD_HEADLESS'] = '1'
  // Off screen and never focused, so the machine stays usable during a run.
  env['QCLOD_E2E_INVISIBLE'] = '1'
  env['QCLOD_USER_DATA'] = profile

  const app = await electron.launch({ args: [REPO_ROOT], env })
  const close = app.close.bind(app)
  app.close = async (): Promise<void> => {
    try {
      await close()
    } finally {
      removeProfile()
    }
  }

  try {
    const win = await app.firstWindow()
    await win.waitForSelector('[data-testid="composer-input"], [data-testid="setup-screen"]', { timeout: 15000 })
    if (opts.size) {
      await app.evaluate(
        ({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s.width, s.height),
        opts.size
      )
    }
    return { app, win, profile }
  } catch (err) {
    await app.close().catch(() => undefined)
    throw err
  }
}

/** The accent the focus ring is drawn in (--accent, #5a8bff). */
const ACCENT_RGB = 'rgb(90, 139, 255)'

/**
 * The focused element shows the ring: either its own outline (not `none`, at
 * least 2 screen pixels), or — for a field marked `.ring-on-parent` — the
 * box-shadow of the nearest `.ring-host` around it, in the accent. Polls, since
 * the host's shadow eases in.
 *
 * The width is counted in screen pixels (CSS px × devicePixelRatio): Chromium
 * snaps an outline to whole screen pixels and reports it back in CSS px, so at
 * zoom 120% a 2px ring reads 1.67px while it is 2 pixels on screen.
 */
export async function expectFocusRing(win: Page): Promise<void> {
  await expect
    .poll(
      () =>
        win.evaluate((accent) => {
          const el = document.activeElement as HTMLElement | null
          if (!el || el === document.body) return 'фокус на body'
          const own = getComputedStyle(el)
          const screenPx = parseFloat(own.outlineWidth) * window.devicePixelRatio
          if (own.outlineStyle !== 'none' && screenPx >= 1.99) return 'ok'
          const host = el.closest('.ring-host')
          if (host && getComputedStyle(host).boxShadow.includes(accent)) return 'ok'
          return `нет кольца: ${el.outerHTML.slice(0, 80)} outline=${own.outlineStyle} ${own.outlineWidth} dpr=${window.devicePixelRatio}`
        }, ACCENT_RGB),
      { timeout: 2000 }
    )
    .toBe('ok')
}
