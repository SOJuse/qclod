import type { SubagentState } from '../../shared/types'

/**
 * How a subagent's state is worded: the one table for the side panel and the
 * ribbon card, so an agent never reads «готов» in one place and «готово» in the other.
 */
export const AGENT_STATE_LABEL: Record<SubagentState, string> = {
  running: 'работает',
  done: 'готов',
  failed: 'ошибка',
  stopped: 'остановлен',
  unfinished: 'не закончил'
}
