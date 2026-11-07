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
 * The hooks the user configured for THEMSELVES, and only those.
 *
 * Qclod deliberately does not forward a project's own
 * .claude/settings.json hooks. Those are commands written by whoever wrote
 * the repository, and Claude Code gates them behind its folder-trust
 * question. Handing them back through --settings would re-present them as
 * the user's own configuration and could run a freshly cloned repository's
 * command without that gate ever being asked.
 *
 * The cost is that a project's hooks may not fire inside Qclod if
 * --settings replaces rather than merges (unverified — see the release
 * checklist). Losing a hook is an inconvenience; running an untrusted
 * repository's command is not.
 *
 * READ ONLY: Qclod never writes to anyone's Claude settings.
 */
export function readUserHooks(home = homedir()): unknown {
  return readHooksFrom(join(home, '.claude', 'settings.json'))
}
