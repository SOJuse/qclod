import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BackgroundTask,
  EffortLevel,
  LimitWindow,
  McpServerInfo,
  ModelOption,
  PanelData,
  PanelSnapshot,
  PermissionMode,
  ProjectSettingsInfo,
  QueuedMessage
} from '../../shared/types'
import type { ContextUsage } from './driver'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * The main conversation's last answer in a record: its model and usage.
 * A subagent's step (it has a parent tool call) is its own window, and
 * `<synthetic>` is what the CLI writes on messages it made up itself — an
 * API error, say — not a model anyone could be on.
 */
function lastMainAnswer(
  messages: unknown[]
): { model: string; usage: Record<string, unknown> | null } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isObject(m) || m['type'] !== 'assistant') continue
    if (typeof m['parent_tool_use_id'] === 'string') continue
    const inner = m['message']
    if (!isObject(inner)) continue
    const model = inner['model']
    if (typeof model !== 'string' || model === '' || model === '<synthetic>') continue
    return { model, usage: isObject(inner['usage']) ? inner['usage'] : null }
  }
  return null
}

/** A percent the meters can draw: a whole number from 0 to 100. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * Utilization as 0..1. The usage call speaks in percent and the event in
 * fractions; a value above 1.5 can only be a percent.
 */
function fraction(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return value > 1.5 ? value / 100 : value
}

/**
 * The window a past conversation's model most likely had. The record names
 * the model but not its window, and assuming 200K for every one of them made
 * an Opus conversation at 380K read «190%». A count past 200K proves the
 * larger window by itself.
 */
export function estimatedWindow(model: string, used: number): number {
  if (model.includes('[1m]') || used > 200_000) return 1_000_000
  // Opus 5 runs with the 1M window (the CLI reports maxTokens 1000000 for it).
  if (/opus-[5-9]/i.test(model)) return 1_000_000
  return 200_000
}

export const EMPTY_PANEL: PanelData = {
  context: null,
  cost: null,
  limits: { fiveHour: null, sevenDay: null },
  model: null,
  models: [],
  effort: null,
  permissionMode: 'default',
  mcp: [],
  projectSettings: null,
  queue: [],
  backgroundTasks: []
}

let lastPanelRev = 0

/**
 * The next panel revision, shared by every collector in the process. A tab's
 * session is replaced on restart or recovery, and the window still holds the
 * old one's revisions: a counter starting from zero again would make every
 * patch of the new session look older than what is already on screen.
 */
export function nextPanelRev(): number {
  lastPanelRev += 1
  return lastPanelRev
}

/**
 * Everything the side panel shows, gathered from the message stream.
 *
 * Each number has one source and the source is named in the spec (6.5), not
 * guessed at: nothing here is computed from something that merely looks
 * related. Before a session starts every field is null, so the panel can say
 * «появится после запуска» instead of showing a confident zero.
 */
export class PanelCollector {
  private panel: PanelData = { ...EMPTY_PANEL, limits: { fiveHour: null, sevenDay: null } }
  /** True once the user has chosen a mode; init must not then overrule them. */
  private modeIsOurs = false
  /** A resumed conversation: the CLI's cost total starts when it was opened. */
  private resumed = false
  /**
   * True once mcpServerStatus has answered. init describes the servers as
   * they were when the CLI started — mostly `pending` — and arrives after the
   * live answer, so it must not then roll «подключён» back to «ждёт».
   */
  private mcpIsLive = false
  /**
   * Taken at birth, not left at zero: a collector made for a restarted tab
   * must outrank everything the window holds from the one before it, even
   * before it has anything to say — otherwise the old session's cost and
   * limits stay on screen.
   */
  private revision = nextPanelRev()

  get data(): PanelData {
    return this.panel
  }

  /** The revision of the last patch, or of the collector's creation. */
  get rev(): number {
    return this.revision
  }

  get snapshot(): PanelSnapshot {
    return { rev: this.revision, data: this.panel }
  }

  apply(message: unknown): Partial<PanelData> | null {
    if (!isObject(message)) return null

    switch (message['type']) {
      case 'system':
        if (message['subtype'] === 'init') return this.onInit(message)
        if (message['subtype'] === 'model_changed') return this.onModelChanged(message)
        return null
      case 'rate_limit_event':
        return this.onRateLimit(message)
      case 'result':
        return this.onResult(message)
      default:
        return null
    }
  }

  /** The SDK reports the mode at start and never again, so ours is the truth. */
  setPermissionMode(mode: string): Partial<PanelData> {
    this.modeIsOurs = true
    return this.patch({ permissionMode: mode as PermissionMode })
  }

  /** Context is not in the turn's result (probe note 4); it is asked for. */
  setContext(usage: ContextUsage): Partial<PanelData> {
    return this.patch({
      // The CLI names its model here before it ever sends init.
      ...(typeof usage.model === 'string' && usage.model !== '' ? { model: usage.model } : {}),
      context: {
        used: usage.totalTokens,
        max: usage.maxTokens,
        // The CLI's percentage is unclamped (0-100+): over the compaction
        // window it read 101% or 190%. The meter shows how full, not how far over.
        percent: clampPercent(usage.percentage),
        // 'free' and 'buffer' are parts of the window the bar draws; 'deferred'
        // tools are not in it yet, so they are not drawn.
        categories: usage.categories.flatMap((c) =>
          c.kind === 'deferred'
            ? []
            : [{ name: c.name, tokens: c.tokens, ...(c.kind === undefined ? {} : { kind: c.kind }) }]
        )
      }
    })
  }

  /** The live answer; from here on it, not init, is what the panel shows. */
  setMcp(list: McpServerInfo[]): Partial<PanelData> {
    this.mcpIsLive = true
    return this.patch({ mcp: list })
  }

  /**
   * The mode as it stands, sent again — after a refused change, so the
   * panel's select stops showing the mode the user picked but did not get.
   */
  currentPermissionMode(): Partial<PanelData> {
    return this.patch({ permissionMode: this.panel.permissionMode })
  }

  setModels(models: ModelOption[]): Partial<PanelData> {
    return this.patch({ models })
  }

  setModel(model: string): Partial<PanelData> {
    return this.patch({ model })
  }

  /**
   * What a past conversation's record says about the panel, before any
   * process is running for it: the model that last answered, and how full
   * its window was by that answer's usage. Both are stand-ins — the context
   * is marked estimated — and what the process reports later replaces them;
   * nothing here overrules what a process already said.
   */
  seedFromTranscript(messages: unknown[]): Partial<PanelData> {
    const last = lastMainAnswer(messages)
    if (!last) return {}
    const patch: Partial<PanelData> = {}
    if (this.panel.model === null) patch.model = last.model
    if (this.panel.context === null && last.usage) {
      const u = last.usage
      const used =
        tokens(u['input_tokens']) +
        tokens(u['cache_creation_input_tokens']) +
        tokens(u['cache_read_input_tokens']) +
        tokens(u['output_tokens'])
      const max = estimatedWindow(last.model, used)
      patch.context = {
        used,
        max,
        percent: clampPercent(Math.round((used / max) * 100)),
        categories: [],
        estimated: true
      }
    }
    return this.patch(patch)
  }

  /** The plan's windows, asked for at start; rate_limit_event updates them after. */
  setLimits(limits: PanelData['limits']): Partial<PanelData> {
    return this.patch({ limits: { fiveHour: limits.fiveHour, sevenDay: limits.sevenDay } })
  }

  /** From here on the reported cost covers only what this process spent. */
  markResumed(): void {
    this.resumed = true
  }

  /** Session-scoped, like the permission mode: ours to remember and show. */
  setEffort(effort: EffortLevel): Partial<PanelData> {
    return this.patch({ effort })
  }

  setProjectSettings(info: ProjectSettingsInfo | null): Partial<PanelData> {
    return this.patch({ projectSettings: info })
  }

  /**
   * The strip: messages the agent has not read yet, with where each one is
   * (`state`) and whether it can be hurried. The session owns them (its
   * outbox), the panel shows them.
   */
  setQueue(queue: QueuedMessage[]): Partial<PanelData> {
    return this.patch({ queue })
  }

  /** The whole list each time: BackgroundTracker hands over a fresh one. */
  setBackgroundTasks(tasks: BackgroundTask[]): Partial<PanelData> {
    return this.patch({ backgroundTasks: tasks })
  }

  private onInit(m: Record<string, unknown>): Partial<PanelData> {
    const patch: Partial<PanelData> = {}
    if (typeof m['model'] === 'string') patch.model = m['model']
    if (!this.modeIsOurs && typeof m['permissionMode'] === 'string') {
      patch.permissionMode = m['permissionMode'] as PermissionMode
    }
    if (!this.mcpIsLive && Array.isArray(m['mcp_servers'])) {
      patch.mcp = (m['mcp_servers'] as Array<Record<string, unknown>>).map((s) => ({
        name: String(s['name'] ?? ''),
        status: String(s['status'] ?? 'pending') as McpServerInfo['status']
      }))
    }
    return this.patch(patch)
  }

  private onModelChanged(m: Record<string, unknown>): Partial<PanelData> | null {
    if (typeof m['model'] !== 'string') return null
    return this.patch({ model: m['model'] })
  }

  private onRateLimit(m: Record<string, unknown>): Partial<PanelData> | null {
    const info = m['rate_limit_info']
    if (!isObject(info)) return null
    const windows = info['unifiedWindows']
    if (!isObject(windows)) return null

    // A window the event leaves out keeps what is known of it: an event about
    // the five-hour window used to wipe the weekly one off the panel.
    const read = (key: string, known: LimitWindow | null): LimitWindow | null => {
      const window = windows[key]
      if (!isObject(window)) return known
      return {
        utilization: fraction(Number(window['utilization'] ?? 0)),
        resetsAt: Number(window['resetsAt'] ?? 0)
      }
    }

    const was = this.panel.limits
    return this.patch({
      limits: { fiveHour: read('five_hour', was.fiveHour), sevenDay: read('seven_day', was.sevenDay) }
    })
  }

  private onResult(m: Record<string, unknown>): Partial<PanelData> | null {
    const cost = m['total_cost_usd']
    // A turn that reported nothing is «ещё ничего», not «стоит ноль»: showing
    // $0.0000 reads as a broken counter.
    if (typeof cost !== 'number' || cost <= 0) return null
    // The SDK reports the session total, not a per-turn delta.
    return this.patch({ cost: this.resumed ? { session: cost, sinceOpen: true } : { session: cost } })
  }

  private patch(patch: Partial<PanelData>): Partial<PanelData> {
    if (Object.keys(patch).length === 0) return patch
    this.panel = { ...this.panel, ...patch }
    this.revision = nextPanelRev()
    return patch
  }
}

// --------------------------------------------------------- project settings

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function countHooks(settings: Record<string, unknown> | null): number {
  const hooks = settings?.['hooks']
  if (!isObject(hooks)) return 0
  let total = 0
  for (const matchers of Object.values(hooks)) {
    for (const matcher of Array.isArray(matchers) ? matchers : []) {
      if (!isObject(matcher)) continue
      total += Array.isArray(matcher['hooks']) ? matcher['hooks'].length : 0
    }
  }
  return total
}

/**
 * What this folder brings with it.
 *
 * Qclod loads project settings immediately, with no trust gate — the user's
 * explicit choice, recorded in spec §5 with its consequence spelled out: a
 * cloned repository's hooks and MCP servers will run. This row is the agreed
 * mitigation, so that the choice is at least visible rather than silent.
 *
 * Read-only, always: the user's settings files are never modified
 * (constraint 5), including the ones inside their own repository.
 */
export function readProjectSettings(cwd: string): ProjectSettingsInfo | null {
  const hooks =
    countHooks(readJson(join(cwd, '.claude', 'settings.json'))) +
    countHooks(readJson(join(cwd, '.claude', 'settings.local.json')))

  const servers = new Set<string>()
  for (const file of [join(cwd, '.mcp.json'), join(cwd, '.claude', 'settings.json')]) {
    const mcp = readJson(file)?.['mcpServers']
    if (isObject(mcp)) for (const name of Object.keys(mcp)) servers.add(name)
  }

  if (hooks === 0 && servers.size === 0) return null
  return { hooks, mcpServers: [...servers] }
}
