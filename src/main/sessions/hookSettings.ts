import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { TabId } from '../../shared/types'

/** Hook events Qclod listens to in order to know what a tab is doing (spec 6.9). */
export const HOOK_EVENTS = ['Stop', 'Notification', 'PermissionRequest', 'SessionEnd'] as const

/** Notification matchers that mean "the agent is waiting on the user". */
export const NOTIFICATION_MATCHERS = [
  'permission_prompt',
  'idle_prompt',
  'agent_needs_input'
] as const

interface HookCommand {
  type: string
  command: string
}
interface HookEntry {
  matcher?: string
  hooks: HookCommand[]
}

function isHookEntryArray(value: unknown): value is HookEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' && entry !== null && Array.isArray((entry as HookEntry).hooks)
    )
  )
}

/**
 * Path of the helper the CLI runs for each hook. Resolved against the app root
 * so it works both from source and from the packaged app.
 */
export function hookHelperPath(): string {
  let root = process.cwd()
  try {
    // Loaded lazily so this module stays importable outside Electron (tests).
    const electron = createRequire(import.meta.url)('electron') as {
      app?: { getAppPath?: () => string }
    }
    if (typeof electron?.app?.getAppPath === 'function') root = electron.app.getAppPath()
  } catch {
    /* not running inside Electron */
  }
  return join(root, 'bin', 'qclod-hook.js')
}

function command(tabId: TabId, pipePath: string, helper = hookHelperPath()): string {
  return `"${process.execPath}" "${helper}" "${pipePath}" "${tabId}"`
}

/**
 * Builds the inline JSON handed to `claude --settings`.
 *
 * `--settings` replaces a key outright, so our hooks are merged into whatever
 * the user already has rather than written over them: silently disabling
 * someone's own hooks for every Qclod session would be a nasty surprise.
 * Anything malformed in the user's config is dropped, never propagated.
 */
export function buildHookSettings(
  tabId: TabId,
  pipePath: string,
  userHooks: unknown,
  helper = hookHelperPath()
): string {
  const ours = command(tabId, pipePath, helper)
  const existing: Record<string, unknown> =
    typeof userHooks === 'object' && userHooks !== null && !Array.isArray(userHooks)
      ? { ...(userHooks as Record<string, unknown>) }
      : {}

  const hooks: Record<string, unknown> = { ...existing }

  for (const event of HOOK_EVENTS) {
    const kept = isHookEntryArray(existing[event]) ? (existing[event] as HookEntry[]) : []
    const mine: HookEntry[] =
      event === 'Notification'
        ? NOTIFICATION_MATCHERS.map((matcher) => ({
            matcher,
            hooks: [{ type: 'command', command: ours }]
          }))
        : [{ hooks: [{ type: 'command', command: ours }] }]
    hooks[event] = [...kept, ...mine]
  }

  return JSON.stringify({ hooks })
}
