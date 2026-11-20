import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type AppSettings,
  type Attachment,
  type EffortLevel,
  type LaunchOverrides,
  type PermissionAnswer,
  type PermissionMode,
  type PlanDecision,
  type RendererErrorReport,
  type TabState,
  type UserInput
} from '../../shared/types'
import { isInsidePasteDir } from '../files/imagePaste'

const MAX_TITLE = 200
const OVERRIDE_KEYS = ['model', 'permissionMode', 'extraFlags', 'effort'] as const

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
    // So is effort: it goes straight to the SDK at the next start.
    if (key === 'effort') {
      if ((EFFORT_LEVELS as readonly string[]).includes(candidate)) {
        out.effort = candidate as EffortLevel
      }
      continue
    }
    out[key] = candidate
  }
  return out
}

/**
 * Launch options as a default for new tabs. Like a tab's own overrides, except
 * that a bypass is not dropped but becomes the ordinary mode: a new tab must not
 * inherit it, and must not come up with no mode at all (spec 5.4).
 */
export function sanitizeDefaults(value: unknown): LaunchOverrides {
  // «Авто-да» is confirmed per tab, so it is no default either.
  const unasked =
    isPlainObject(value) &&
    (value['permissionMode'] === 'bypassPermissions' || value['permissionMode'] === 'autoAllow')
  const out = sanitizeOverrides(value)
  if (unasked) out.permissionMode = 'default'
  return out
}

const MAX_EDITOR_COMMAND = 1000

/** An editor command is a line of text; anything else (or a runaway one) is no value at all. */
export function sanitizeEditorCommand(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_EDITOR_COMMAND ? value : undefined
}

/** No path to an executable is this long; a longer string is not one. */
const MAX_AGENT_PATH = 4096
/** No accelerator is this long. */
const MAX_HOTKEY = 100
const BOOLEAN_SETTINGS = ['notificationsEnabled', 'soundEnabled', 'closeToTray', 'panelOpen'] as const

/**
 * The plain fields of a settings patch, each of its own type, and nothing
 * else: an unknown key or a wrong type is dropped, never stored. `defaults`
 * and `editorCommand` have sanitisers of their own (mergeDefaults).
 */
export function sanitizeSettingsFields(
  value: unknown
): Partial<Omit<AppSettings, 'defaults' | 'editorCommand'>> {
  if (!isPlainObject(value)) return {}
  const out: Partial<Omit<AppSettings, 'defaults' | 'editorCommand'>> = {}
  const agentPath = value['agentPath']
  if (isString(agentPath) && agentPath.length <= MAX_AGENT_PATH && !agentPath.includes('\0')) {
    out.agentPath = agentPath
  }
  const hotkey = value['globalHotkey']
  if (isString(hotkey) && hotkey.length <= MAX_HOTKEY) out.globalHotkey = hotkey
  for (const key of BOOLEAN_SETTINGS) {
    if (typeof value[key] === 'boolean') out[key] = value[key] as boolean
  }
  return out
}

/**
 * Settings with a patch applied. Every field of the patch is checked: the
 * defaults are sanitised, an editor command that is not a usable string leaves
 * the old one, and anything else unknown or of the wrong type is dropped.
 */
export function mergeDefaults(settings: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const { defaults, editorCommand } = isPlainObject(patch) ? patch : {}
  const rest = sanitizeSettingsFields(patch)
  const merged = { ...settings.defaults, ...(defaults === undefined ? {} : sanitizeDefaults(defaults)) }
  // An empty string is how the settings screen says "as Claude Code has it":
  // the key goes away rather than being stored as an empty value.
  if (isPlainObject(defaults)) {
    for (const key of ['model', 'effort', 'extraFlags'] as const) {
      if (defaults[key] === '') delete merged[key]
    }
  }
  return {
    ...settings,
    ...rest,
    editorCommand: sanitizeEditorCommand(editorCommand) ?? settings.editorCommand,
    defaults: merged
  }
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

/** A thumbnail is a small picture, inline; anything longer is not one. */
const MAX_THUMBNAIL = 200_000

function isSide(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100_000
}

/**
 * A message from the renderer is text plus attachments, and nothing else.
 *
 * An image may carry a thumbnail (only an inline `data:image/` picture) and
 * the path of its copy, kept only when it is one of the app's own pasted files
 * in `userData`: that path is opened later from the chat.
 */
export function sanitizeInput(value: unknown, userData?: string): UserInput {
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
      const image: Extract<Attachment, { kind: 'image' }> = {
        kind: 'image',
        mediaType: attachment['mediaType'],
        dataBase64: attachment['dataBase64']
      }
      const { path, thumbnail, width, height } = attachment
      if (isString(path) && userData !== undefined && isInsidePasteDir(userData, path)) {
        image.path = path
      }
      if (isString(thumbnail) && thumbnail.startsWith('data:image/') && thumbnail.length <= MAX_THUMBNAIL) {
        image.thumbnail = thumbnail
      }
      if (isSide(width) && isSide(height)) {
        image.width = width
        image.height = height
      }
      attachments.push(image)
    }
  }
  return { text, attachments }
}

const MAX_ANSWER = 2000
/** A card asks at most four questions; this is only a ceiling on garbage. */
const MAX_ANSWERS = 64
const MAX_QUESTION = 2000

/**
 * The answers of a question card: question text -> chosen label(s). An answer
 * is a choice, not a document, so non-strings and long values are dropped. Which
 * keys are real questions is checked by the session, which knows them.
 */
export function sanitizeQuestionAnswers(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {}
  const out: Record<string, string> = {}
  let kept = 0
  for (const [question, answer] of Object.entries(value)) {
    if (kept >= MAX_ANSWERS) break
    if (typeof answer !== 'string' || answer.length > MAX_ANSWER) continue
    if (question.length > MAX_QUESTION) continue
    out[question] = answer
    kept += 1
  }
  return out
}

/**
 * The user's comments on the options chosen in a question card: question text
 * -> comment. Bounded like the answers themselves; an empty comment is none.
 */
export function sanitizeQuestionNotes(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {}
  const out: Record<string, string> = {}
  let kept = 0
  for (const [question, note] of Object.entries(value)) {
    if (kept >= MAX_ANSWERS) break
    if (typeof note !== 'string' || note === '' || note.length > MAX_ANSWER) continue
    if (question.length > MAX_QUESTION) continue
    out[question] = note
    kept += 1
  }
  return out
}

/** A comment or a deny reason is a line or two from the person, not a document. */
const MAX_COMMENT = 2000
/** A plan the user edited: long, but not unbounded. */
const MAX_PLAN = 100_000

/** A non-empty string no longer than `max`, or nothing: a longer one is not cut, it is dropped. */
function boundedText(value: unknown, max: number): string | undefined {
  return isString(value) && value !== '' && value.length <= max ? value : undefined
}

/**
 * What the user decided about a plan. Only a literal true approves; a comment
 * and an edited plan pass when they are strings of a sane length.
 */
export function sanitizePlanDecision(value: unknown): PlanDecision {
  if (!isPlainObject(value)) return { approve: false }
  const decision: PlanDecision = { approve: value['approve'] === true }
  const comment = boundedText(value['comment'], MAX_COMMENT)
  if (comment !== undefined) decision.comment = comment
  const plan = boundedText(value['plan'], MAX_PLAN)
  if (plan !== undefined) decision.plan = plan
  return decision
}

/**
 * An answer is allow or deny — anything else is a deny. A malformed payload
 * must never widen a permission, and `updatedInput` never crosses from the
 * window: it would let the window rewrite the tool call it is approving.
 * «До конца сессии» goes only with an allow, a reason only with a deny.
 */
export function sanitizeAnswer(value: unknown): PermissionAnswer {
  if (typeof value !== 'object' || value === null) return { behavior: 'deny' }
  const answer = value as Record<string, unknown>
  const behavior = answer['behavior'] === 'allow' ? 'allow' : 'deny'
  const out: PermissionAnswer = {
    behavior,
    ...(answer['remember'] === true ? { remember: true } : {})
  }
  if (behavior === 'allow' && answer['forSession'] === true) out.forSession = true
  const message = behavior === 'deny' ? boundedText(answer['message'], MAX_COMMENT) : undefined
  if (message !== undefined) out.message = message
  return out
}

const MAX_ERROR_TEXT = 20_000
const ERROR_SCOPES: readonly string[] = ['app', 'pane', 'window']

/** An error report from the window: a known scope and a message, strings cut to a sane length; anything else is dropped. */
export function sanitizeErrorReport(value: unknown): RendererErrorReport | null {
  if (!isPlainObject(value)) return null
  const { scope, message, stack, componentStack } = value
  if (!isString(scope) || !ERROR_SCOPES.includes(scope) || !isString(message)) return null
  const report: RendererErrorReport = {
    scope: scope as RendererErrorReport['scope'],
    message: message.slice(0, MAX_ERROR_TEXT)
  }
  if (isString(stack)) report.stack = stack.slice(0, MAX_ERROR_TEXT)
  if (isString(componentStack)) report.componentStack = componentStack.slice(0, MAX_ERROR_TEXT)
  return report
}
