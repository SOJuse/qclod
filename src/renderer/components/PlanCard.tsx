import type { RibbonItem } from '../../shared/types'

type Plan = Extract<RibbonItem, { kind: 'plan' }>

/** How a closed plan reads; «elsewhere» was answered on the phone or claude.ai. */
const DONE_LABEL: Record<Plan['state'], string> = {
  pending: '',
  approved: 'принят',
  rejected: 'отклонён',
  elsewhere: 'ответили с телефона или claude.ai'
}

interface Props {
  item: Plan
  onAnswer: (requestId: string, approve: boolean) => void
}

/**
 * What the agent intends to do, before it does any of it.
 *
 * Not a permission dialog: there is nothing to allow yet, there is a plan to
 * read. Approving it also leaves plan mode, because staying in it would stop
 * the agent doing the very thing that was just approved (spec 6.4).
 */
export function PlanCard({ item, onAnswer }: Props): JSX.Element {
  return (
    <div className={`row-plan is-${item.state}`} data-testid="plan-card">
      <div className="row-plan-head">План работы</div>
      <div className="row-plan-text" data-testid="plan-text">
        {item.text}
      </div>
      {item.state === 'pending' ? (
        <div className="row-plan-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="plan-approve"
            title="Выполнять этот план"
            onClick={() => onAnswer(item.requestId, true)}
          >
            Выполнять
          </button>
          <button
            type="button"
            className="btn"
            data-testid="plan-reject"
            title="Не выполнять, обсудить ещё"
            onClick={() => onAnswer(item.requestId, false)}
          >
            Ещё обсудим
          </button>
        </div>
      ) : (
        <div className="row-plan-done">
          {DONE_LABEL[item.state]}
        </div>
      )}
    </div>
  )
}
