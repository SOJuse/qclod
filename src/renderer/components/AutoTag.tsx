import './AutoTag.css'

/** The mark on what «авто-да» answered for the person; stage 3 puts it in the user's bubble too. */
export function AutoTag(): JSX.Element {
  return (
    <span className="auto-tag" data-testid="auto-tag" title="Ответил Qclod сам">
      авто
    </span>
  )
}
