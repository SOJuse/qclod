import type { SubagentState } from '../../shared/types'

/** How a subagent's state is worded, in the side panel and on the ribbon card alike. */
export const AGENT_STATE_LABEL: Record<SubagentState, string> = {
  running: 'работает',
  done: 'готов',
  failed: 'ошибка',
  stopped: 'остановлен',
  unfinished: 'не закончил'
}
