import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/** Saves a screenshot to QCLOD_SHOT_DIR (default tests/.artifacts/shots). */
export async function shot(win: Page, name: string): Promise<void> {
  const dir = process.env['QCLOD_SHOT_DIR'] ?? 'tests/.artifacts/shots'
  mkdirSync(dir, { recursive: true })
  await win.screenshot({ path: join(dir, name + '.png') })
}
