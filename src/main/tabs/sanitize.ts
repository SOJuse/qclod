import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type AppSettings,
  type Attachment,
  type EffortLevel,
  type LaunchOverrides,
  type LayoutPatch,
  type PermissionAnswer,
  type PermissionMode,
  type PlanDecision,
  type RendererErrorReport,
  type TabAutonomyRecord,
  type TabState,
  type UserInput,
  TEMPLATE_LIMITS,
  type TemplateDraft
} from '../../shared/types'
import {
  VOICE_MODEL_IDS,
  type VoiceModelId,
  type VoiceReplacement,
  type VoiceSettings
} from '../../shared/voice'
import { clip } from '../../shared/format'
import { parseSites } from '../../shared/vpn'
import { isInsidePasteDir } from '../files/imagePaste'
import { isSafeSshTarget } from '../ssh/sshArgs'

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
const BOOLEAN_SETTINGS = [
  'notificationsEnabled',
  'soundEnabled',
  'closeToTray',
  'panelOpen',
  'openAtLogin'
] as const
/** «Авто-да» waits at least a minute and at most an hour before answering by itself. */
const AUTO_ANSWER_MINUTES_MIN = 1
const AUTO_ANSWER_MINUTES_MAX = 60

// Stage 5: voice
const MAX_REPLACEMENTS = 300
const MAX_REPLACEMENT_TEXT = 60
const MAX_PCM_SAMPLES = 4800

export function sanitizeModelId(v: unknown): VoiceModelId | null {
  return typeof v === 'string' && (VOICE_MODEL_IDS as readonly string[]).includes(v)
    ? (v as VoiceModelId)
    : null
}

function replacementText(v: unknown): string | null {
  if (!isString(v)) return null
  const t = v.trim()
  // eslint-disable-next-line no-control-regex
  if (t.length < 1 || t.length > MAX_REPLACEMENT_TEXT || /[\u0000-\u001f\u007f]/.test(t)) return null
  return t
}

/** The voice part of a settings patch: a known model, a bounded dictionary or null. */
export function sanitizeVoiceSettings(v: unknown): Partial<VoiceSettings> {
  if (!isPlainObject(v)) return {}
  const out: Partial<VoiceSettings> = {}
  const model = sanitizeModelId(v['model'])
  if (model !== null) out.model = model
  const list = v['replacements']
  if (list === null) {
    out.replacements = null
  } else if (Array.isArray(list) && list.length <= MAX_REPLACEMENTS) {
    const seen = new Set<string>()
    const entries: VoiceReplacement[] = []
    for (const item of list) {
      if (!isPlainObject(item)) continue
      const from = replacementText(item['from'])
      const to = replacementText(item['to'])
      if (from === null || to === null) continue
      const key = from.toLowerCase().replace(/ё/g, 'е')
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({ from, to })
    }
    out.replacements = entries
  }
  return out
}

/** One chunk of microphone sound: at most 4800 samples, finite and within [-1, 1]; a copy. */
export function sanitizePcm(v: unknown): Float32Array | null {
  if (!(v instanceof Float32Array) || v.length < 1 || v.length > MAX_PCM_SAMPLES) return null
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) {
    const x = v[i]
    out[i] = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0
  }
  return out
}

/**
 * The plain fields of a settings patch, each of its own type, and nothing
 * else: an unknown key or a wrong type is dropped, never stored. `defaults`
 * and `editorCommand` have sanitisers of their own (mergeDefaults).
 */
export function sanitizeSettingsFields(
  value: unknown
): Partial<Omit<AppSettings, 'defaults' | 'editorCommand' | 'voice'>> {
  if (!isPlainObject(value)) return {}
  const out: Partial<Omit<AppSettings, 'defaults' | 'editorCommand' | 'voice'>> = {}
  const agentPath = value['agentPath']
  if (isString(agentPath) && agentPath.length <= MAX_AGENT_PATH && !agentPath.includes('\0')) {
    out.agentPath = agentPath
  }
  const hotkey = value['globalHotkey']
  if (isString(hotkey) && hotkey.length <= MAX_HOTKEY) out.globalHotkey = hotkey
  for (const key of BOOLEAN_SETTINGS) {
    if (typeof value[key] === 'boolean') out[key] = value[key] as boolean
  }
  const minutes = value['autoAnswerMinutes']
  if (
    typeof minutes === 'number' &&
    Number.isInteger(minutes) &&
    minutes >= AUTO_ANSWER_MINUTES_MIN &&
    minutes <= AUTO_ANSWER_MINUTES_MAX
  ) {
    out.autoAnswerMinutes = minutes
  }
  return out
}

/**
 * A tab's autonomy record as tabs.json keeps it: `working` and `remote` only
 * as a literal true, `limitUntil` only as a finite time after the epoch.
 * Anything else is dropped; a record with nothing left is none.
 */
export function sanitizeAutonomyRecord(value: unknown): TabAutonomyRecord | undefined {
  if (!isPlainObject(value)) return undefined
  const out: TabAutonomyRecord = {}
  if (value['working'] === true) out.working = true
  if (value['remote'] === true) out.remote = true
  const until = value['limitUntil']
  if (typeof until === 'number' && Number.isFinite(until) && until > 0) out.limitUntil = until
  return Object.keys(out).length === 0 ? undefined : out
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
    voice: {
      ...settings.voice,
      ...sanitizeVoiceSettings(isPlainObject(patch) ? patch['voice'] : undefined)
    },
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

/** A deny reason or a note on an option: a line or two from the person. */
const MAX_NOTE = 2000
/** What the user says with a plan decision. */
const MAX_PLAN_COMMENT = 4000
/** A plan the user edited: long, but not unbounded. */
const MAX_PLAN = 100_000

/**
 * A text from the person, trimmed: nothing when it is not a string, empty
 * after trimming, or longer than `max`. Never cut — a cut text says something
 * else than what was written.
 */
function personText(value: unknown, max: number): string | undefined {
  if (!isString(value)) return undefined
  const text = value.trim()
  return text !== '' && text.length <= max ? text : undefined
}

/** What the person writes to a subagent: as long as a message can sensibly be. */
const MAX_SUBAGENT_TEXT = 50_000

/**
 * A message to a subagent (stage 4), trimmed: null when it is not a string,
 * empty after trimming, or longer than 50 000 characters.
 */
export function sanitizeSubagentText(value: unknown): string | null {
  return personText(value, MAX_SUBAGENT_TEXT) ?? null
}

/** A ribbon card's id from the window (stage 4): a short string, never an SDK id. */
const MAX_CARD_ID = 64

export function sanitizeCardId(value: unknown): string | null {
  return isString(value) && value !== '' && value.length <= MAX_CARD_ID ? value : null
}

/**
 * The user's comments on the options chosen in a question card: question text
 * -> comment, trimmed. An empty or over-long comment is none.
 */
export function sanitizeQuestionNotes(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {}
  const out: Record<string, string> = {}
  let kept = 0
  for (const [question, given] of Object.entries(value)) {
    if (kept >= MAX_ANSWERS) break
    const note = personText(given, MAX_NOTE)
    if (note === undefined || question.length > MAX_QUESTION) continue
    out[question] = note
    kept += 1
  }
  return out
}

/**
 * What the user decided about a plan, or null when it is no usable answer —
 * the card then stays open. Only a literal true approves. An edited plan goes
 * only with an approval; one that is there but unusable (not a string, empty,
 * too long) spoils the whole decision rather than being dropped: otherwise the
 * agent would carry out the plan the user had changed.
 */
export function sanitizePlanDecision(value: unknown): PlanDecision | null {
  if (!isPlainObject(value)) return null
  const approve = value['approve'] === true
  const decision: PlanDecision = { approve }
  const given = value['plan']
  if (given !== undefined) {
    if (!isString(given) || given.trim() === '' || given.length > MAX_PLAN) return null
    if (approve) decision.plan = given
  }
  const comment = personText(value['comment'], MAX_PLAN_COMMENT)
  if (comment !== undefined) decision.comment = comment
  return decision
}

/**
 * An answer is allow or deny — anything else is a deny. A malformed payload
 * must never widen a permission, and `updatedInput` never crosses from the
 * window: it would let the window rewrite the tool call it is approving.
 * «До конца сессии» goes only with an allow, and over `remember` the narrower
 * answer wins: a session's permission must not be saved as a rule for ever.
 * A reason goes only with a deny.
 */
export function sanitizeAnswer(value: unknown): PermissionAnswer {
  if (typeof value !== 'object' || value === null) return { behavior: 'deny' }
  const answer = value as Record<string, unknown>
  const behavior = answer['behavior'] === 'allow' ? 'allow' : 'deny'
  if (behavior === 'allow' && answer['forSession'] === true) return { behavior, forSession: true }
  const out: PermissionAnswer = {
    behavior,
    ...(answer['remember'] === true ? { remember: true } : {})
  }
  const message = behavior === 'deny' ? personText(answer['message'], MAX_NOTE) : undefined
  if (message !== undefined) out.message = message
  return out
}

/** A split holds at most this many chats side by side. */
const MAX_PANES = 4
/** A tab id is a UUID; no id is this long. */
const MAX_PANE_ID = 200
/** No folder path is this long; a longer string is not worth a project lookup. */
const MAX_LAYOUT_CWD = 4096

/**
 * What the window may change in the layout: the split's chats (ids, each
 * once, at most four) and their widths (shares above zero, at most four), the
 * sidebar, and one project's folding. Which chats are active and which
 * folders are projects are main's to say, so they never come from here.
 * Whether the ids are live chats is checked where they are used.
 */
export function sanitizeLayoutPatch(value: unknown): LayoutPatch {
  if (!isPlainObject(value)) return {}
  const patch: LayoutPatch = {}

  const panes = value['panes']
  if (Array.isArray(panes)) {
    const kept: string[] = []
    for (const id of panes) {
      if (kept.length >= MAX_PANES) break
      if (!isString(id) || id === '' || id.length > MAX_PANE_ID || kept.includes(id)) continue
      kept.push(id)
    }
    patch.panes = kept
  }

  const widths = value['paneWidths']
  if (Array.isArray(widths)) {
    const kept: number[] = []
    for (const w of widths) {
      if (kept.length >= MAX_PANES) break
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) kept.push(w)
    }
    patch.paneWidths = kept
  }

  if (typeof value['sidebarCollapsed'] === 'boolean') patch.sidebarCollapsed = value['sidebarCollapsed']

  const folding = value['projectCollapsed']
  if (isPlainObject(folding)) {
    const { cwd, collapsed, hostId } = folding
    if (isString(cwd) && cwd !== '' && cwd.length <= MAX_LAYOUT_CWD && typeof collapsed === 'boolean') {
      // Stage 6: a server's project, by that server's id.
      const host = isString(hostId) && hostId !== '' && hostId.length <= 200 ? hostId : undefined
      patch.projectCollapsed = { cwd, collapsed, ...(host ? { hostId: host } : {}) }
    }
  }
  return patch
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

// ---------------------------------------------------------------- stage 6: servers

const MAX_SERVER_VALUE = 4096
const MAX_HOST_ID = 64
const MAX_TARGET = 255

/** A server's id as main made it: short, no spaces. */
export function sanitizeHostId(value: unknown): string | null {
  if (!isString(value) || value === '' || value.length > MAX_HOST_ID || !/^[\w.-]+$/.test(value)) return null
  return value
}

/**
 * A server from the form. The target goes to ssh as an argument: whitespace,
 * a control character or a leading `-` (ssh would take it for an option) and
 * it is no target. A port outside 1–65535 is refused.
 */
export function sanitizeServerEntry(value: unknown): {
  id?: string
  label: string
  target: string
  port?: number
  identityFile?: string
  auth: 'key' | 'password'
  colour?: import('../../shared/types').ServerColour
  fromConfig: boolean
} | null {
  if (!isPlainObject(value)) return null
  const { id, label, target, port, identityFile, auth, colour, fromConfig } = value
  if (!isString(target) || target === '' || target.length > MAX_TARGET) return null
  // Letters, digits and ._@[]:%+- only, never a leading `-` (I10, CVE-2023-51385).
  if (!isSafeSshTarget(target)) return null
  if (label !== undefined && (!isString(label) || label.length > MAX_TITLE || /[\r\n\0]/.test(label))) return null
  let cleanPort: number | undefined
  if (port !== undefined && port !== null) {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
    cleanPort = port
  }
  let key: string | undefined
  if (identityFile !== undefined && identityFile !== '') {
    if (!isString(identityFile) || identityFile.length > MAX_SERVER_VALUE || /[\r\n\0]/.test(identityFile) || identityFile.startsWith('-')) {
      return null
    }
    key = identityFile
  }
  const knownColours = ['blue', 'violet', 'green', 'amber', 'rose', 'cyan']
  return {
    ...(id !== undefined && sanitizeHostId(id) ? { id: id as string } : {}),
    label: isString(label) ? label.trim() : '',
    target,
    ...(cleanPort !== undefined ? { port: cleanPort } : {}),
    ...(key ? { identityFile: key } : {}),
    auth: auth === 'password' ? 'password' : 'key',
    ...(isString(colour) && knownColours.includes(colour) ? { colour: colour as import('../../shared/types').ServerColour } : {}),
    fromConfig: fromConfig === true
  }
}

/** A password to keep: a string of at most 4096, one line (askpass prints it as one). */
export function sanitizeServerPassword(value: unknown): string | null {
  if (!isString(value) || value === '' || value.length > MAX_SERVER_VALUE || /[\r\n\0]/.test(value)) return null
  return value
}

/** The person's answer to ssh's question: a known shape, a value of at most 4096 on one line. */
export function sanitizePromptAnswer(value: unknown): import('../../shared/types').SshPromptAnswer | null {
  if (!isPlainObject(value)) return null
  const { promptId, ok, value: given, remember } = value
  if (!isString(promptId) || promptId === '' || promptId.length > MAX_HOST_ID) return null
  if (ok !== true) return { promptId, ok: false }
  if (!isString(given) || given.length > MAX_SERVER_VALUE || /[\r\n\0]/.test(given)) return null
  return { promptId, ok: true, value: given, ...(remember === true ? { remember: true } : {}) }
}

/** A path on a server: at most 4096 characters, no NUL; `~` is the home there. */
export function sanitizeRemotePath(value: unknown): string | null {
  if (!isString(value) || value.length > MAX_SERVER_VALUE || value.includes('\0')) return null
  return value
}

/** Stage 6: a server terminal's id — what TerminalHub handed out (a uuid). */
export function sanitizeTerminalId(value: unknown): string | null {
  return isString(value) && /^[0-9a-f-]{36}$/i.test(value) ? value : null
}

/** Stage 6: keystrokes for a server terminal, at most 64 KiB at a time. */
export function sanitizeTerminalInput(value: unknown): string | null {
  return isString(value) && value.length > 0 && value.length <= 64 * 1024 ? value : null
}

// — этап 7: шаблоны
const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** An empty title is the body's first line, this long at most. */
const TEMPLATE_AUTO_TITLE = 60

/**
 * A template from the window: a body that is not blank and within the limit,
 * a title within the limit (blank — the body's first line), a plain id if
 * any, a known origin. Anything else — null, and nothing is saved.
 */
export function sanitizeTemplateDraft(value: unknown): TemplateDraft | null {
  if (!isPlainObject(value)) return null
  const { id, title, body, origin } = value
  if (!isString(body)) return null
  const text = body.trim()
  if (text === '' || text.length > TEMPLATE_LIMITS.body) return null
  if (title !== undefined && !isString(title)) return null
  let name = (title ?? '').trim()
  if (name.length > TEMPLATE_LIMITS.title) return null
  if (name === '') {
    const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? text
    name = clip(firstLine.trim(), TEMPLATE_AUTO_TITLE)
  }
  if (id !== undefined && (!isString(id) || !TEMPLATE_ID.test(id))) return null
  const draft: TemplateDraft = { title: name, body: text, origin: origin === 'harvest' ? 'harvest' : 'manual' }
  return id !== undefined ? { id: id as string, ...draft } : draft
}

/** At most this many projects left out of «Собрать мои шаблоны». */
const MAX_EXCLUDED = 200

/** The projects left out of «Собрать»: an array of at most 200 strings, else none. */
export function sanitizeExcludedProjects(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_EXCLUDED) return []
  if (!value.every((v) => isString(v) && v.length > 0 && v.length <= 1000)) return []
  return value as string[]
}

/** A stored template id: what the window may name in «удалить». */
export function isTemplateId(value: unknown): value is string {
  return isString(value) && TEMPLATE_ID.test(value)
}

// 1.0.1: vpn
/** A pasted hysteria2:// link (or '' to forget it): a string of at most 4096 characters. */
export function sanitizeVpnLink(value: unknown): string | null {
  return isString(value) && value.length <= 4096 ? value : null
}

/** «Подключаться при запуске» and «Сайты через VPN»; anything else is dropped. */
export function sanitizeVpnOptions(value: unknown): { autoConnect?: boolean; sites?: string[] | 'defaults' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const o = value as Record<string, unknown>
  const out: { autoConnect?: boolean; sites?: string[] | 'defaults' } = {}
  if (typeof o['autoConnect'] === 'boolean') out.autoConnect = o['autoConnect']
  if (o['sites'] === 'defaults') out.sites = 'defaults'
  else if (isString(o['sites']) && o['sites'].length <= 50_000) out.sites = parseSites(o['sites'])
  else if (Array.isArray(o['sites']) && o['sites'].length <= 1000 && o['sites'].every(isString)) out.sites = parseSites(o['sites'])
  return out
}
