import type { AgentNode } from './agentModel'

export const NODE_W = 232,
  NODE_H = 76,
  ROOT_W = 152,
  COL_GAP = 56,
  ROW_GAP = 12

export interface GraphLayout {
  root: { x: number; y: number }
  /** Top-left corner of each node, by its id. */
  placed: Map<string, { x: number; y: number }>
  edges: Array<{ from: string /* 'main' или id */; to: string; live: boolean }>
  width: number
  height: number
}

const ROW = NODE_H + ROW_GAP

/**
 * A tree laid out left to right (решение автора плана 2: it is always a tree,
 * so no general graph library). The column is the depth, the main agent is
 * column 0; leaves take rows one after another in depth-first ribbon order;
 * a parent sits midway between its first and last child, the root midway
 * along the first column.
 */
export function layoutGraph(nodes: AgentNode[]): GraphLayout {
  const known = new Set(nodes.map((n) => n.id))
  const children = new Map<string, AgentNode[]>()
  for (const node of nodes) {
    // A parent the list does not hold (it cannot happen from agentNodes) hangs off the root.
    const key = node.parentId !== null && known.has(node.parentId) ? node.parentId : 'main'
    const list = children.get(key)
    if (list) list.push(node)
    else children.set(key, [node])
  }

  const placed = new Map<string, { x: number; y: number }>()
  const edges: GraphLayout['edges'] = []
  let nextRow = 0
  let maxColumn = 0

  /** Places a node and everything under it; answers its row. */
  const place = (node: AgentNode, column: number, from: string, path: Set<string>): number => {
    maxColumn = Math.max(maxColumn, column)
    edges.push({ from, to: node.id, live: node.state === 'running' })
    const kids = path.has(node.id) ? [] : (children.get(node.id) ?? [])
    let row: number
    if (kids.length === 0) {
      row = nextRow++
    } else {
      path.add(node.id)
      const rows = kids.map((kid) => place(kid, column + 1, node.id, path))
      path.delete(node.id)
      row = (rows[0]! + rows[rows.length - 1]!) / 2
    }
    placed.set(node.id, { x: ROOT_W + COL_GAP + (column - 1) * (NODE_W + COL_GAP), y: row * ROW })
    return row
  }

  const top = children.get('main') ?? []
  const topRows = top.map((node) => place(node, 1, 'main', new Set()))
  const rootRow = topRows.length > 0 ? (topRows[0]! + topRows[topRows.length - 1]!) / 2 : 0
  // Edges in ribbon order, as the nodes came, not as the walk reached them.
  const order = new Map(nodes.map((n, i) => [n.id, i]))
  edges.sort((a, b) => (order.get(a.to) ?? 0) - (order.get(b.to) ?? 0))

  return {
    root: { x: 0, y: rootRow * ROW },
    placed,
    edges,
    width: maxColumn === 0 ? ROOT_W : ROOT_W + COL_GAP + maxColumn * NODE_W + (maxColumn - 1) * COL_GAP,
    height: Math.max(1, nextRow) * ROW - ROW_GAP
  }
}
