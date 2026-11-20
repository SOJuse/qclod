import { rmSync } from 'node:fs'
import { basename } from 'node:path'

/**
 * The run's throwaway profile (playwright.config.ts) goes when the run ends:
 * left behind, thousands of them once filled the disk (Ruling M2). Only a
 * folder the config made is deleted, never one given from outside.
 */
export default function globalTeardown(): void {
  const profile = process.env['QCLOD_E2E_PROFILE']
  if (!profile || !basename(profile).startsWith('qclod-e2e-')) return
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
