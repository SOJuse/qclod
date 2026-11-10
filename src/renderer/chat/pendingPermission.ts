import type { RibbonItem } from '../../shared/types'

type Permission = Extract<RibbonItem, { kind: 'permission' }>

/**
 * The permission the keys answer: the earliest one still waiting. Only
 * top-level cards count — a subagent's own items live inside its card.
 */
export function oldestPendingPermission(items: RibbonItem[]): Permission | null {
  for (const item of items) {
    if (item.kind === 'permission' && item.state === 'pending' && item.parentId === undefined) {
      return item
    }
  }
  return null
}
