import {
  PERMISSION_MODES,
  type LaunchOverrides,
  type PermissionAnswer,
  type PermissionMode,
  type TabState,
  type UserInput
} from '../../shared/types'

const MAX_TITLE = 200
const OVERRIDE_KEYS = ['model', 'permissionMode', 'extraFlags'] as const

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

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
      // A tab's stored launch options are not a place to turn the permission
      // gate off: that one mode is reached only through the confirmation.
      if (candidate === 'bypassPermissions') continue
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

/** A message from the renderer is text plus attachments, and nothing else. */
export function sanitizeInput(value: unknown): UserInput {
  if (typeof value !== 'object' || value === null) return { text: '', attachments: [] }
  const input = value as Record<string, unknown>
  const text = isString(input['text']) ? input['text'] : ''

  const attachments: UserInput['attachments'] = []
  for (const entry of Array.isArray(input['attachments']) ? input['attachments'] : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const attachment = entry as Record<string, unknown>
    if (attachment['kind'] === 'file' && isString(attachment['path'])) {
      attachments.push({ kind: 'file', path: attachment['path'] })
    } else if (
      attachment['kind'] === 'image' &&
      isString(attachment['mediaType']) &&
      isString(attachment['dataBase64'])
    ) {
      attachments.push({
        kind: 'image',
        mediaType: attachment['mediaType'],
        dataBase64: attachment['dataBase64']
      })
    }
  }
  return { text, attachments }
}

/**
 * An answer is allow or deny — anything else is a deny. A malformed payload
 * must never widen a permission, and `updatedInput` never crosses from the
 * window: it would let the window rewrite the tool call it is approving.
 */
export function sanitizeAnswer(value: unknown): PermissionAnswer {
  if (typeof value !== 'object' || value === null) return { behavior: 'deny' }
  const answer = value as Record<string, unknown>
  return {
    behavior: answer['behavior'] === 'allow' ? 'allow' : 'deny',
    ...(answer['remember'] === true ? { remember: true } : {})
  }
}
