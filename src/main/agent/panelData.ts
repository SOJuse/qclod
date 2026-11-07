import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  EffortLevel,
  McpServerInfo,
  ModelOption,
  PanelData,
  PermissionMode,
  ProjectSettingsInfo
} from '../../shared/types'
import type { ContextUsage } from './driver'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
  projectSettings: null
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

  get data(): PanelData {
    return this.panel
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
      context: {
        used: usage.totalTokens,
        max: usage.maxTokens,
        percent: usage.percentage,
        // 'free' and 'buffer' rows are the window, not the content in it.
        categories: usage.categories
          .filter((c) => c.kind === undefined || c.kind === 'used')
          .map((c) => ({ name: c.name, tokens: c.tokens }))
      }
    })
  }

  setModels(models: ModelOption[]): Partial<PanelData> {
    return this.patch({ models })
  }

  setModel(model: string): Partial<PanelData> {
    return this.patch({ model })
  }

  /** Session-scoped, like the permission mode: ours to remember and show. */
  setEffort(effort: EffortLevel): Partial<PanelData> {
    return this.patch({ effort })
  }

  setProjectSettings(info: ProjectSettingsInfo | null): Partial<PanelData> {
    return this.patch({ projectSettings: info })
  }

  private onInit(m: Record<string, unknown>): Partial<PanelData> {
    const patch: Partial<PanelData> = {}
    if (typeof m['model'] === 'string') patch.model = m['model']
    if (!this.modeIsOurs && typeof m['permissionMode'] === 'string') {
      patch.permissionMode = m['permissionMode'] as PermissionMode
    }
    if (Array.isArray(m['mcp_servers'])) {
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

    const read = (key: string): PanelData['limits']['fiveHour'] => {
      const window = windows[key]
      if (!isObject(window)) return null
      return {
        utilization: Number(window['utilization'] ?? 0),
        resetsAt: Number(window['resetsAt'] ?? 0)
      }
    }

    return this.patch({ limits: { fiveHour: read('five_hour'), sevenDay: read('seven_day') } })
  }

  private onResult(m: Record<string, unknown>): Partial<PanelData> | null {
    const cost = m['total_cost_usd']
    if (typeof cost !== 'number') return null
    // The SDK reports the session total, not a per-turn delta.
    return this.patch({ cost: { session: cost } })
  }

  private patch(patch: Partial<PanelData>): Partial<PanelData> {
    this.panel = { ...this.panel, ...patch }
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
