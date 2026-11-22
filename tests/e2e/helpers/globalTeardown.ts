import { rmSync } from 'node:fs'
import { basename } from 'node:path'

/**
 * The run's throwaway profile and Claude Code folder (playwright.config.ts) go
 * when the run ends: left behind, thousands of them once filled the disk
 * (Ruling M2). Only a folder the config made is deleted, never one given from outside.
 */
export default function globalTeardown(): void {
  for (const dir of [process.env['QCLOD_E2E_PROFILE'], process.env['QCLOD_E2E_CLAUDE_CONFIG']]) {
    if (!dir || !basename(dir).startsWith('qclod-e2e-')) continue
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
