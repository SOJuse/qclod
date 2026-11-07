import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSION_MODES, type LaunchOverrides, PersistedTab } from '../../shared/types'

export const TABS_FILE = 'tabs.json'

export interface LoadedTab extends PersistedTab {
  /** The folder this tab points at is gone. The tab survives; it is flagged. */
  missingCwd: boolean
}

export function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function sanitizeOverrides(value: unknown): LaunchOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const out: LaunchOverrides = {}
  for (const key of ['model', 'permissionMode', 'extraFlags'] as const) {
    const candidate = source[key]
    if (typeof candidate !== 'string') continue
    if (key === 'permissionMode' && !PERMISSION_MODES.includes(candidate as never)) continue
    out[key] = candidate as never
  }
  return out
}

/**
 * Only what the spec says survives a restart: working directory, title and
 * launch overrides. Session content is never written to disk (constraint 5.4),
 * and sessions start fresh — `--resume` is deliberately not used (spec 6.3).
 */
export function saveTabs(dir: string, tabs: PersistedTab[]): void {
  mkdirSync(dir, { recursive: true })
  const minimal = tabs.map((tab) => ({
    id: tab.id,
    cwd: tab.cwd,
    title: tab.title,
    overrides: sanitizeOverrides(tab.overrides)
  }))
  writeFileSync(join(dir, TABS_FILE), JSON.stringify(minimal, null, 2), 'utf8')
}

export function loadTabs(dir: string): LoadedTab[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, TABS_FILE), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const tabs: LoadedTab[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record['id'] !== 'string' || typeof record['cwd'] !== 'string') continue
    tabs.push({
      id: record['id'],
      cwd: record['cwd'],
      title: typeof record['title'] === 'string' ? record['title'] : record['cwd'],
      overrides: sanitizeOverrides(record['overrides']),
      missingCwd: !isDirectory(record['cwd'])
    })
  }
  return tabs
}
