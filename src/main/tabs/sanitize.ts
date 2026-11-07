import {
  PERMISSION_MODES,
  type LaunchOverrides,
  type PermissionMode,
  type TabState
} from '../../shared/types'

const MAX_TITLE = 200
const OVERRIDE_KEYS = ['model', 'permissionMode', 'extraFlags'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Launch flags the renderer may set per tab. Note what is NOT here: the agent
 * executable itself. Which binary runs is a global setting, never something a
 * tab can redirect.
 */
export function sanitizeOverrides(value: unknown): LaunchOverrides {
  if (!isPlainObject(value)) return {}
  const out: LaunchOverrides = {}
  for (const key of OVERRIDE_KEYS) {
    const candidate = value[key]
    if (typeof candidate !== 'string') continue
    // permissionMode is an enum, not free text: an unknown value would reach
    // the SDK and be rejected there, far from where it was introduced.
    if (key === 'permissionMode') {
      if (!(PERMISSION_MODES as readonly string[]).includes(candidate)) continue
      out.permissionMode = candidate as PermissionMode
      continue
    }
    out[key] = candidate
  }
  return out
}

/**
 * The only tab fields the renderer owns. Everything else — cwd, status, error,
 * badge, id — is the main process's to decide, and accepting them from the
 * renderer would let a bug there silently relaunch an agent elsewhere or
 * fake a state the session is not actually in.
 */
export function sanitizeTabPatch(value: unknown): Partial<TabState> {
  if (!isPlainObject(value)) return {}
  const patch: Partial<TabState> = {}

  if (typeof value['title'] === 'string') {
    patch.title = (value['title'] as string).slice(0, MAX_TITLE)
  }
  if (isPlainObject(value['overrides'])) {
    patch.overrides = sanitizeOverrides(value['overrides'])
  }
  return patch
}
