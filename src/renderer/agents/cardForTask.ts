import type { RibbonItem } from '../../shared/types'

/**
 * The subagent card a background task belongs to, by its task id — which the
 * live CLI also gives as the agent's id (05b, сценарий 1). null: none in this
 * ribbon (an old record), and the agents layer opens on all of them.
 */
export function cardForTask(items: RibbonItem[], taskId: string): string | null {
  for (const item of items) {
    if (item.kind === 'subagent' && (item.taskId === taskId || item.agentId === taskId)) return item.id
  }
  return null
}
