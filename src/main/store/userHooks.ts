import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readHooksFrom(path: string): Record<string, unknown> | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
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
  return hooks as Record<string, unknown>
}

/**
 * The hooks the user configured for themselves.
 *
 * READ ONLY: Qclod never writes to anyone's Claude settings.
 */
export function readUserHooks(home = homedir()): unknown {
  return readHooksFrom(join(home, '.claude', 'settings.json'))
}

/**
 * Every hook that would apply to a session in `cwd`, merged in the order
 * Claude Code resolves them: user, then project, then the project's local
 * overrides.
 *
 * `--settings` replaces a key outright, so Qclod has to hand back everything
 * it would otherwise displace. A repo's own `.claude/settings.json` hooks are
 * somebody's hooks exactly as much as the user's are, and spec 6.9 is explicit
 * that silently disabling them is unacceptable.
 */
export function collectHooks(cwd: string, home = homedir()): unknown {
  const sources = [
    join(home, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json')
  ]

  const merged: Record<string, unknown> = {}
  let found = false

  for (const path of sources) {
    const hooks = readHooksFrom(path)
    if (!hooks) continue
    found = true
    for (const [event, entries] of Object.entries(hooks)) {
      const existing = merged[event]
      merged[event] =
        Array.isArray(existing) && Array.isArray(entries) ? [...existing, ...entries] : entries
    }
  }

  return found ? merged : undefined
}
