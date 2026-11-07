import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Reads the hooks the user configured for themselves, so Qclod can merge its
 * own alongside instead of replacing them (`--settings` overwrites a key
 * outright). READ ONLY: Qclod never writes to the user's Claude settings.
 */
export function readUserHooks(home = homedir()): unknown {
  let raw: string
  try {
    raw = readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
  } catch {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const hooks = (parsed as { hooks?: unknown }).hooks
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return undefined
  return hooks
}
