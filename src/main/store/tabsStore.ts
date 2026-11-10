import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistedTab } from '../../shared/types'
import { sanitizeOverrides } from '../tabs/sanitize'

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

/**
 * Only what the spec says survives a restart: working directory, title, launch
 * overrides and the id of the conversation the tab was last in.
 *
 * The id is a pointer, not content: the messages themselves live where the CLI
 * already keeps them, and Qclod never writes a word of the conversation to
 * disk (constraint 5.4).
 */
export function saveTabs(dir: string, tabs: PersistedTab[]): void {
  mkdirSync(dir, { recursive: true })
  const minimal = tabs.map((tab) => ({
    id: tab.id,
    cwd: tab.cwd,
    title: tab.title,
    overrides: sanitizeOverrides(tab.overrides),
    ...(typeof tab.lastSessionId === 'string' ? { lastSessionId: tab.lastSessionId } : {})
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
      ...(typeof record['lastSessionId'] === 'string'
        ? { lastSessionId: record['lastSessionId'] }
        : {}),
      missingCwd: !isDirectory(record['cwd'])
    })
  }
  return tabs
}
