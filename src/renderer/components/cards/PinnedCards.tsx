import { useMemo } from 'react'
import { plural } from '../../../shared/format'
import type { RibbonItem, TabId } from '../../../shared/types'
import type { CardAnswers } from '../../chat/cardAnswers'
import { PINNED_KINDS, cardIdOf, openCards } from '../../chat/openCards'
import { PermissionCard } from './PermissionCard'
import { PinnedCard } from './PinnedCard'
import { PlanCard } from './PlanCard'
import { QuestionCard } from './QuestionCard'
import type { AutoAnswerView, OpenCard } from './types'

export interface PinnedCardsProps {
  tabId: TabId
  items: RibbonItem[]
  answers: CardAnswers
  /** Set while «авто-да» is about to answer this card. */
  autoAnswerFor?: (card: OpenCard) => AutoAnswerView | undefined
}

const TITLE: Record<OpenCard['kind'], string> = {
  permission: 'Разрешение',
  question: 'Вопрос',
  plan: 'План'
}

/** The card's own body. */
function body(card: OpenCard, answers: CardAnswers): JSX.Element {
  switch (card.kind) {
    case 'permission':
      return <PermissionCard item={card.item} answers={answers} focused />
    case 'question':
      return <QuestionCard item={card.item} answers={answers} focused />
    case 'plan':
      return <PlanCard item={card.item} answers={answers} focused tabId={card.tabId} />
  }
}

/**
 * What waits for the person, pinned above the input: one card at a time, the
 * oldest first, a subagent's own ones too (decision 6), and how many more wait
 * behind it. Answering one brings up the next.
 */
export function PinnedCards({ tabId, items, answers, autoAnswerFor }: PinnedCardsProps): JSX.Element | null {
  const cards = useMemo(
    () => openCards(items, tabId).filter((card) => PINNED_KINDS.has(card.kind)),
    [items, tabId]
  )
  const card = cards[0]
  if (!card) return null
  const id = cardIdOf(card)
  const auto = autoAnswerFor?.(card)
  const more = cards.length - 1
  return (
    <div className="pinned-cards" data-testid="pinned-cards">
      <PinnedCard
        key={id}
        kind={card.kind}
        title={TITLE[card.kind]}
        cardId={id}
        {...(card.fromAgent !== undefined ? { from: card.fromAgent } : {})}
        {...(auto ? { autoAnswer: auto } : {})}
      >
        {body(card, answers)}
      </PinnedCard>
      {more > 0 && (
        <div className="pinned-more" data-testid="pinned-more">
          Ещё {more} {plural(more, 'ждёт', 'ждут', 'ждут')} ответа
        </div>
      )}
    </div>
  )
}
