import type { RibbonItem, SubagentItem, SubagentState } from '../../shared/types'

/**
 * One subagent of a chat as the agents layer draws it: a node of the tree
 * «главный агент → сабагенты → вложенные», built from the ribbon's cards.
 */
export interface AgentNode {
  /** The card's id in the ribbon. */
  id: string
  /** The nearest subagent card above it, or null — started by the main agent. */
  parentId: string | null
  /** 1 — started by the main agent. */
  depth: number
  name: string
  task: string
  state: SubagentState
  background: boolean
  startedAt?: number
  endedAt?: number
  durationMs?: number
  tokens?: number
  toolCalls?: number
  model?: string
  /**
   * What it is doing or what came of it. A running agent without a progress
   * summary shows its last tool: the live CLI sends task_progress.summary only
   * after a while, if at all (05b, «Что не совпало» 2).
   */
  summary: string
  runs: number
}

/**
 * Every subagent card of a ribbon, in ribbon order. A card's parent is the
 * nearest subagent among its ancestors: a card whose parentId names something
 * else at the top (a SendMessage call) belongs to the main agent.
 */
export function agentNodes(items: RibbonItem[]): AgentNode[] {
  const byId = new Map<string, RibbonItem>()
  for (const item of items) byId.set(item.id, item)

  const parentOf = (item: RibbonItem): string | null => {
    const seen = new Set<string>()
    let up = item.parentId
    while (up !== undefined && !seen.has(up)) {
      seen.add(up)
      const above = byId.get(up)
      if (!above) return null
      if (above.kind === 'subagent') return above.id
      up = above.parentId
    }
    return null
  }

  const depthById = new Map<string, number>()
  const depthOf = (id: string, parentId: string | null, guard = 0): number => {
    const known = depthById.get(id)
    if (known !== undefined) return known
    let depth = 1
    if (parentId !== null && guard < 64) {
      const parent = byId.get(parentId)
      depth = parent ? depthOf(parentId, parentOf(parent), guard + 1) + 1 : 1
    }
    depthById.set(id, depth)
    return depth
  }

  const nodes: AgentNode[] = []
  for (const item of items) {
    if (item.kind !== 'subagent') continue
    const parentId = parentOf(item)
    nodes.push(toNode(item, parentId, depthOf(item.id, parentId)))
  }
  return nodes
}

function toNode(item: SubagentItem, parentId: string | null, depth: number): AgentNode {
  const running = item.state === 'running'
  return {
    id: item.id,
    parentId,
    depth,
    name: item.name,
    task: item.task,
    state: item.state,
    background: item.background === true,
    ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
    ...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {}),
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    ...(item.tokens !== undefined ? { tokens: item.tokens } : {}),
    ...(item.toolCalls !== undefined ? { toolCalls: item.toolCalls } : {}),
    ...(item.model !== undefined ? { model: item.model } : {}),
    summary: item.summary || (running ? (item.lastTool ?? '') : ''),
    runs: item.runs ?? 1
  }
}

/**
 * How long it has worked: a running one — until now; a finished one — its own
 * total, else from its start to its end; nothing known — null.
 */
export function elapsedMs(node: AgentNode, now: number): number | null {
  if (node.state === 'running' && node.startedAt !== undefined) return Math.max(0, now - node.startedAt)
  if (node.durationMs !== undefined) return node.durationMs
  if (node.endedAt !== undefined && node.startedAt !== undefined) return Math.max(0, node.endedAt - node.startedAt)
  return null
}

/** What the graph's layout depends on: who, under whom, and whether it is live. */
export function nodesKey(nodes: AgentNode[]): string {
  return nodes.map((n) => `${n.id}\u0001${n.state}\u0001${n.parentId ?? ''}`).join('\u0002')
}
