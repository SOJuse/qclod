import { compactNumber, plural, seconds } from '../../../shared/format'
import type { CostRates } from '../../../shared/types'
import { elapsedMs, type AgentNode } from '../../agents/agentModel'
import { estimateCost, usd } from '../../agents/cost'
import { AGENT_STATE_LABEL } from '../agentState'
import { STATE_ICON } from '../SubagentCard'

/** «Explore · 42k токенов · ≈ $0.0421 · 3 вызова · claude-haiku-5-5»: what does not fit in the node. */
export function agentDetails(node: AgentNode, rates: CostRates | null, withModel = false): string[] {
  const parts: string[] = []
  if (node.tokens !== undefined && node.tokens > 0) {
    parts.push(`${compactNumber(node.tokens)} токенов`)
    const cost = estimateCost(node.tokens, node.model, rates)
    parts.push(cost === null ? 'стоимость неизвестна' : `≈ ${usd(cost)}`)
  }
  if (node.toolCalls !== undefined && node.toolCalls > 0) {
    parts.push(`${node.toolCalls} ${plural(node.toolCalls, 'вызов', 'вызова', 'вызовов')}`)
  }
  if (withModel && node.model) parts.push(node.model)
  return parts
}

/** «работает · 12 с» — the word, and the time if any is known. */
export function stateWithTime(node: AgentNode, now: number): string {
  const ms = elapsedMs(node, now)
  return ms === null ? AGENT_STATE_LABEL[node.state] : `${AGENT_STATE_LABEL[node.state]} · ${seconds(ms)}`
}

/**
 * One subagent in the graph: what it is, what it was asked, how it is going.
 * The rest — tokens, cost, calls — is in the hint. A click (or Enter) opens
 * its own ribbon.
 */
export function AgentNodeView({
  node,
  now,
  costRates,
  style,
  onOpen
}: {
  node: AgentNode
  now: number
  costRates: CostRates | null
  style?: React.CSSProperties
  onOpen: (id: string) => void
}): JSX.Element {
  const running = node.state === 'running'
  const Icon = STATE_ICON[node.state]
  const title = [node.name, ...agentDetails(node, costRates)].join(' · ')
  return (
    <button
      type="button"
      className={`agent-node is-${node.state}`}
      data-testid="agent-node"
      data-node-id={node.id}
      data-state={node.state}
      title={title}
      style={style}
      onClick={() => onOpen(node.id)}
    >
      <span className="agent-node-line">
        <span className="agent-node-kind">{node.name}</span>
        {node.background && <span className="agent-badge">фон</span>}
        {node.runs > 1 && <span className="agent-badge">запуск {node.runs}</span>}
      </span>
      <span className="agent-node-task">{node.task}</span>
      <span className="agent-node-state">
        <Icon size={13} className={running ? 'tool-spin' : undefined} aria-hidden="true" />
        <span>{stateWithTime(node, now)}</span>
        {running && node.summary && <span className="agent-node-summary"> · {node.summary}</span>}
      </span>
    </button>
  )
}
