import type { RibbonItem, TabId } from '../../shared/types'
import type { OpenCard } from '../components/cards/types'

/**
 * Kinds of card that have a place in the pinned strip above the input. A card
 * leaves the ribbon only when its kind is here; until then the old card in
 * the ribbon stays the one place it can be answered. Each task that renders a
 * kind in the strip adds it (П2: permissions and questions now; plans with
 * their own card).
 */
export const PINNED_KINDS: ReadonlySet<OpenCard['kind']> = new Set<OpenCard['kind']>(['permission', 'question'])

type CardItem = Extract<RibbonItem, { kind: 'permission' | 'question' | 'plan' }>

function isCardItem(item: RibbonItem): item is CardItem {
  return item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan'
}

/** A question the conversation moved on from: the person wrote something after it. */
export function isStaleQuestion(item: RibbonItem, items: RibbonItem[]): boolean {
  if (item.kind !== 'question' || item.answers !== null || item.elsewhere) return false
  const at = items.indexOf(item)
  return at >= 0 && items.slice(at + 1).some((later) => later.kind === 'user')
}

/** Waiting for the user right now. */
export function isOpenCard(item: RibbonItem, items: RibbonItem[]): boolean {
  switch (item.kind) {
    case 'permission':
    case 'plan':
      return item.state === 'pending'
    case 'question':
      return item.answers === null && !item.elsewhere && !isStaleQuestion(item, items)
    default:
      return false
  }
}

/** Open, and shown in the pinned strip rather than the ribbon. */
export function isPinnedCard(item: RibbonItem, items: RibbonItem[]): boolean {
  return isCardItem(item) && PINNED_KINDS.has(item.kind) && isOpenCard(item, items)
}

/** Every open card, in ribbon order, a subagent's own ones too. */
export function openCards(items: RibbonItem[], tabId: TabId): OpenCard[] {
  const agentName = new Map<string, string>()
  for (const item of items) if (item.kind === 'subagent') agentName.set(item.id, item.name)
  const cards: OpenCard[] = []
  for (const item of items) {
    if (!isCardItem(item) || !isOpenCard(item, items)) continue
    const fromAgent = item.parentId === undefined ? undefined : agentName.get(item.parentId)
    const base = { tabId, ...(fromAgent !== undefined ? { fromAgent } : {}) }
    if (item.kind === 'question') cards.push({ ...base, kind: 'question', toolUseId: item.toolUseId, item })
    else if (item.kind === 'permission') cards.push({ ...base, kind: 'permission', requestId: item.requestId, item })
    else cards.push({ ...base, kind: 'plan', requestId: item.requestId, item })
  }
  return cards
}

/** One id per card: a question's tool use, a permission's or plan's request. Shared with the pinned strip and stage 3's timers. */
export function cardIdOf(card: OpenCard): string {
  return card.kind === 'question' ? card.toolUseId : card.requestId
}
