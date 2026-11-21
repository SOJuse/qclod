import type { RibbonItem } from '../../shared/types'

/**
 * A subagent's own ribbon, to read it as a chat of its own: everything under
 * its card, in one pass. Its direct children lose their parentId, so the
 * ribbon draws them as rows; deeper ones keep it and live inside the cards of
 * the agents it started, as in the main ribbon.
 */
export function subRibbon(items: RibbonItem[], cardId: string): RibbonItem[] {
  const inside = new Set<string>([cardId])
  const out: RibbonItem[] = []
  for (const item of items) {
    if (item.parentId === undefined || !inside.has(item.parentId)) continue
    inside.add(item.id)
    if (item.parentId === cardId) {
      const { parentId: _drop, ...rest } = item
      out.push(rest as RibbonItem)
    } else {
      out.push(item)
    }
  }
  return out
}
