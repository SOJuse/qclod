/**
 * A card's text field — a refusal's reason, a comment on a chosen option, an
 * answer in one's own words. main drops a longer text whole (S2-R4, S2-R5), so
 * the field never takes more.
 */
export const CARD_TEXT_MAX = 2000
/** What is said with a plan decision: main's MAX_PLAN_COMMENT (S2-R5). */
export const PLAN_COMMENT_MAX = 4000
/** A plan the person edited: main's MAX_PLAN (S2-R5). */
export const PLAN_TEXT_MAX = 100_000

/** From nine tenths of the limit on, the field says how much room is left. */
function countFrom(max: number): number {
  return Math.floor(max * 0.9)
}

/** «1900 / 2000» beside a card's field near its limit; nothing before that. */
export function TextCount({
  length,
  testId,
  max = CARD_TEXT_MAX
}: {
  length: number
  testId: string
  /** The field's own limit; a card's usual one unless said. */
  max?: number
}): JSX.Element | null {
  if (length < countFrom(max)) return null
  return (
    <span className="card-text-count" data-testid={testId}>
      {length} / {max}
    </span>
  )
}
