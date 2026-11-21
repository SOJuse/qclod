/**
 * Writing to a subagent. CLI 2.1.317 has no direct way in (05 §3.2): the
 * person's message goes to the main agent, which passes it on with
 * SendMessage. Pure: no Electron, no session.
 */

/** A message the person wrote to a subagent, as the queue carries it beside the instruction. */
export interface RelayMeta {
  relayId: string
  /** The subagent's card in the ribbon. */
  cardId: string
  /** The agent as the person reads it — its kind, the card's name. */
  agent: string
  /** What the person wrote, as they wrote it. */
  text: string
}

/** What the main agent is told (stage 4, decision 5): one string, kept in shared for the ribbon. */
export { relayInstruction } from '../../shared/relayText'

/**
 * The address SendMessage takes: the agent's id, else its task id, else the
 * name it was given. Null — the agent has not started yet: nothing to write to.
 */
export function agentRef(card: { agentId?: string; taskId?: string; label?: string }): string | null {
  return card.agentId || card.taskId || card.label || null
}

/**
 * How a message reaches a subagent on this CLI: through the main agent, or
 * not at all — `init.tools` lists no SendMessage. Before init nothing is known
 * against it. The one place to change when a CLI offers a direct way.
 */
export function subagentRoute(init: Record<string, unknown> | null): 'main' | 'none' {
  if (!init) return 'main'
  const tools = init['tools']
  if (Array.isArray(tools) && !tools.includes('SendMessage')) return 'none'
  return 'main'
}
