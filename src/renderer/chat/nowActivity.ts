import { clip } from '../../shared/format'
import { mcpParts, toolCategory, type ToolCategory } from '../../shared/toolCategory'
import type { RibbonItem, SessionStatus } from '../../shared/types'

export type NowCategory = ToolCategory | 'thinking' | 'writing' | 'waiting'

export interface RunningAgent {
  id: string
  /** The agent kind, e.g. Explore. */
  name: string
  task: string
  lastTool?: string
}

/** What the agent is doing this moment, in words: «Читает index.ts». */
export interface NowActivity {
  category: NowCategory
  verb: string
  object: string
  objectKind: 'path' | 'code' | 'text' | 'none'
  /** The full path, when the object is a file's name. */
  path?: string
  runningAgents: RunningAgent[]
}

type ToolItem = Extract<RibbonItem, { kind: 'tool' }>
type SubagentItem = Extract<RibbonItem, { kind: 'subagent' }>
type Said = Pick<NowActivity, 'verb' | 'object' | 'objectKind' | 'path'>

const VERB: Record<string, string> = {
  Read: 'Читает',
  Glob: 'Ищет файлы',
  Grep: 'Ищет',
  WebSearch: 'Ищет в сети',
  WebFetch: 'Открывает',
  Edit: 'Правит',
  MultiEdit: 'Правит',
  NotebookEdit: 'Правит',
  Write: 'Пишет',
  Bash: 'Запускает',
  PowerShell: 'Запускает',
  Agent: 'Поручил агенту',
  Task: 'Поручил агенту',
  TodoWrite: 'Обновляет план'
}

/** A command line is long; the line itself cuts it with an ellipsis, this only bounds it. */
const OBJECT_MAX = 300

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter((s) => s !== '').pop() ?? path
}

function host(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

const none = (verb: string): Said => ({ verb, object: '', objectKind: 'none' })
const text = (verb: string, object: string): Said =>
  object ? { verb, object: clip(object, OBJECT_MAX), objectKind: 'text' } : none(verb)
const code = (verb: string, object: string): Said =>
  object ? { verb, object: clip(object, OBJECT_MAX), objectKind: 'code' } : none(verb)

/** The verb for a tool and the one thing it is acting on. */
function sayTool(item: ToolItem): Said {
  const input = item.input ?? {}
  const mcp = mcpParts(item.name)
  if (mcp) return text('MCP', `${mcp.server} · ${mcp.tool}`)

  const verb = VERB[item.name] ?? 'Вызывает'
  switch (item.name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const path = str(input.file_path) || str(input.notebook_path) || item.target
      return path ? { verb, object: fileName(path), objectKind: 'path', path } : none(verb)
    }
    case 'Bash':
    case 'PowerShell':
      return code(verb, str(input.command) || item.target)
    case 'Glob':
      return code(verb, str(input.pattern) || item.target)
    case 'Grep': {
      const pattern = str(input.pattern)
      return pattern ? text(verb, `"${pattern}"`) : text(verb, item.target)
    }
    case 'WebSearch': {
      const query = str(input.query)
      return query ? text(verb, `"${query}"`) : text(verb, item.target)
    }
    case 'WebFetch':
      return text(verb, host(str(input.url) || item.target))
    case 'Agent':
    case 'Task':
      return text(verb, str(input.description) || item.target)
    case 'TodoWrite':
      return none(verb)
    default:
      return text(verb, item.name)
  }
}

function asRunning(item: SubagentItem): RunningAgent {
  return {
    id: item.id,
    name: item.name,
    task: item.task,
    ...(item.lastTool ? { lastTool: item.lastTool } : {})
  }
}

/**
 * The live line's content: what the newest working top-level item is doing,
 * and every subagent still at work.
 *
 * Null when nothing is: the session is not in a turn and no subagent runs.
 * Between turns, background agents still running get the line alone, with
 * no verb (the main agent is not doing anything).
 */
export function nowActivity(items: RibbonItem[], status: SessionStatus): NowActivity | null {
  const agents = items.filter((i): i is SubagentItem => i.kind === 'subagent' && i.state === 'running')
  const inTurn = status === 'busy' || status === 'waiting'
  if (!inTurn) {
    if (!agents.some((a) => a.parentId === undefined)) return null
    return { category: 'agent', ...none(''), runningAgents: agents.map(asRunning) }
  }

  const others = (named?: string): RunningAgent[] => agents.filter((a) => a.id !== named).map(asRunning)

  if (status === 'waiting') return { category: 'waiting', ...none('Ждёт ответа'), runningAgents: others() }

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.parentId !== undefined) continue
    if (item.kind === 'tool' && item.state === 'running') {
      return { category: toolCategory(item.name), ...sayTool(item), runningAgents: others() }
    }
    // A background agent works on its own; the turn is not waiting on it.
    if (item.kind === 'subagent' && item.state === 'running' && !item.background) {
      return { category: 'agent', ...text('Поручил агенту', item.task), runningAgents: others(item.id) }
    }
    if (item.kind === 'thinking' && !item.done) {
      return { category: 'thinking', ...none('Думает'), runningAgents: others() }
    }
    if (item.kind === 'agentText' && item.streaming) {
      return { category: 'writing', ...none('Пишет ответ'), runningAgents: others() }
    }
  }
  return { category: 'thinking', ...none('Думает'), runningAgents: others() }
}
