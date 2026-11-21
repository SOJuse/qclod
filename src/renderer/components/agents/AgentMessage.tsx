import './AgentsLayer.css'
import { clockTime } from '../../../shared/format'
import type { RelayState, RibbonItem } from '../../../shared/types'

type Item = Extract<RibbonItem, { kind: 'agentMessage' }>

/** What became of a message the person wrote to a subagent. */
export const RELAY_STATE_LABEL: Record<RelayState, string> = {
  sent: 'ждёт главного агента',
  read: 'главный агент прочитал',
  passed: 'передано',
  cancelled: 'не передано'
}

/**
 * One message of the conversation with a subagent, in its ribbon: the
 * person's on the right — it goes through the main agent, and says how far
 * it got; the main agent's own SendMessage on the left.
 */
export function AgentMessage({ item }: { item: Item }): JSX.Element {
  const person = item.from === 'person'
  const caption = person
    ? ['через главного агента', item.state ? RELAY_STATE_LABEL[item.state] : null].filter(Boolean).join(' · ')
    : 'от главного агента'
  return (
    <div
      className={`agent-message is-${item.from}${item.state ? ` is-${item.state}` : ''}`}
      data-testid="agent-message"
      data-state={item.state}
    >
      <div className="agent-message-text">{item.text}</div>
      <div className="agent-message-caption">
        {caption}
        {item.at !== undefined && <span className="agent-message-time"> · {clockTime(item.at)}</span>}
      </div>
    </div>
  )
}
