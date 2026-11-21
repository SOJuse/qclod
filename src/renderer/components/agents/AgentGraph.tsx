import { useMemo } from 'react'
import { Bot } from 'lucide-react'
import type { CostRates } from '../../../shared/types'
import { nodesKey, type AgentNode } from '../../agents/agentModel'
import { NODE_H, NODE_W, ROOT_W, layoutGraph } from '../../agents/graphLayout'
import { AgentNodeView } from './AgentNodeView'

/** A smooth S from the right edge of one box to the left edge of the next column's box. */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const mid = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
}

/**
 * The chat's agents as a tree, left to right: the main agent, the agents it
 * started, theirs. Boxes are buttons laid out by hand; the links are one SVG
 * under them. The layout is worked out again only when who, under whom, or
 * live changes (nodesKey) — not on every tick of the clock.
 */
export function AgentGraph({
  nodes,
  now,
  costRates,
  onOpen
}: {
  nodes: AgentNode[]
  now: number
  costRates: CostRates | null
  onOpen: (id: string) => void
}): JSX.Element {
  const key = nodesKey(nodes)
  // Keyed on the nodes' shape, not on the array: a new ribbon with the same tree keeps the layout.
  const layout = useMemo(() => layoutGraph(nodes), [key])
  const mid = NODE_H / 2
  return (
    <div className="agent-graph" data-testid="agent-graph" style={{ width: layout.width, height: layout.height }}>
      <svg className="agent-edges" width={layout.width} height={layout.height} aria-hidden="true">
        {layout.edges.map((edge) => {
          const to = layout.placed.get(edge.to)
          const from = edge.from === 'main' ? { x: layout.root.x, y: layout.root.y, w: ROOT_W } : { ...layout.placed.get(edge.from)!, w: NODE_W }
          if (!to) return null
          return (
            <path
              key={edge.to}
              className={`agent-edge${edge.live ? ' is-live' : ''}`}
              d={edgePath(from.x + from.w, from.y + mid, to.x, to.y + mid)}
            />
          )
        })}
      </svg>
      <div className="agent-root" style={{ left: layout.root.x, top: layout.root.y, width: ROOT_W, height: NODE_H }}>
        <Bot size={14} aria-hidden="true" />
        <span>Главный агент</span>
      </div>
      {nodes.map((node) => {
        const at = layout.placed.get(node.id)
        if (!at) return null
        return (
          <AgentNodeView
            key={node.id}
            node={node}
            now={now}
            costRates={costRates}
            style={{ left: at.x, top: at.y, width: NODE_W, height: NODE_H }}
            onOpen={onOpen}
          />
        )
      })}
    </div>
  )
}
