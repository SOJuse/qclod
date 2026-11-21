import { useMemo } from 'react'
import type { AgentNode } from '../../agents/agentModel'
import { layoutTimeline } from '../../agents/timelineLayout'
import { stateWithTime } from './AgentNodeView'

const pct = (share: number): string => `${share * 100}%`

/**
 * The chat's agents on one time scale: a row each — its kind and task on the
 * left, its bar on the right, coloured by its state. A running bar's right
 * edge is open and breathes; a click opens the agent's own ribbon.
 */
export function AgentTimeline({
  nodes,
  now,
  onOpen
}: {
  nodes: AgentNode[]
  now: number
  onOpen: (id: string) => void
}): JSX.Element {
  const layout = useMemo(() => layoutTimeline(nodes, now), [nodes, now])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  return (
    <div className="agent-timeline" data-testid="agent-timeline">
      <div className="agent-timeline-ticks" aria-hidden="true">
        <span className="agent-timeline-label" />
        <span className="agent-timeline-scale">
          {layout.ticks.map((tick) => (
            <span key={tick.label} className="agent-tick" style={{ left: pct(tick.at) }}>
              {tick.label}
            </span>
          ))}
        </span>
      </div>
      {layout.rows.map((row) => {
        const node = byId.get(row.id)
        if (!node) return null
        return (
          <button
            key={row.id}
            type="button"
            className="agent-row"
            data-testid="agent-row"
            data-state={node.state}
            title={`${node.name} · ${stateWithTime(node, now)}`}
            onClick={() => onOpen(row.id)}
          >
            <span className="agent-timeline-label">
              <span className="agent-row-kind">{node.name}</span>
              <span className="agent-row-task">{node.task}</span>
            </span>
            <span className="agent-timeline-scale">
              {layout.ticks.map((tick) => (
                <span key={tick.label} className="agent-grid" style={{ left: pct(tick.at) }} aria-hidden="true" />
              ))}
              <span
                className={`agent-bar is-${node.state}${row.open ? ' is-open' : ''}`}
                style={{ left: pct(row.left), width: pct(row.width) }}
              />
            </span>
          </button>
        )
      })}
      {layout.untimed > 0 && (
        <div className="agent-timeline-untimed" data-testid="agents-untimed">
          Без отметок времени: {layout.untimed}
        </div>
      )}
    </div>
  )
}
