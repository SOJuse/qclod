/**
 * A card's text field — a refusal's reason, a comment on a chosen option, an
 * answer in one's own words. main drops a longer text whole (S2-R4, S2-R5), so
 * the field never takes more.
 */
export const CARD_TEXT_MAX = 2000
/** From here on the field says how much room is left. */
const COUNT_FROM = 1800

/** «1900 / 2000» beside a card's field near its limit; nothing before that. */
export function TextCount({ length, testId }: { length: number; testId: string }): JSX.Element | null {
  if (length < COUNT_FROM) return null
  return (
    <span className="card-text-count" data-testid={testId}>
      {length} / {CARD_TEXT_MAX}
    </span>
  )
}
