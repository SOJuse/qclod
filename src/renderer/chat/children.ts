import type { RibbonItem } from '../../shared/types'

/**
 * Every nested item, grouped under the subagent it belongs to, in ribbon order.
 *
 * One pass over the ribbon: the ribbon builds this once per render and hands
 * each card its own list, rather than every card filtering the whole ribbon
 * for its children. A nested subagent is a child of its parent, and its own
 * steps sit under its id, so the same map serves every level.
 */
export function childrenByParent(items: RibbonItem[]): ReadonlyMap<string, RibbonItem[]> {
  const map = new Map<string, RibbonItem[]>()
  for (const item of items) {
    if (item.parentId === undefined) continue
    const list = map.get(item.parentId)
    if (list) list.push(item)
    else map.set(item.parentId, [item])
  }
  return map
}
