import { Circle, CircleCheck, CircleX, LoaderCircle, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ConnectStep, ServerConnState } from '../../../shared/types'
import { pendingSteps } from '../../../shared/serverTexts'

const STEP_ICON: Record<ConnectStep['state'], LucideIcon> = {
  pending: Circle,
  running: LoaderCircle,
  ok: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX
}

const STATE_LABEL: Record<ConnectStep['state'], string> = {
  pending: 'ждёт',
  running: 'идёт',
  ok: 'готово',
  warn: 'внимание',
  fail: 'не вышло'
}

interface Props {
  steps?: ConnectStep[] | undefined
  /** Shown under the steps: the server's own problem (a changed host key says what to do). */
  problem?: string | undefined
  /** The server's state: a changed host key makes the problem a danger (R5). */
  problemState?: ServerConnState | undefined
  busy?: boolean
  onRetry: () => void
}

/** The five steps of connecting a server, each with its state, and «Проверить снова». */
export function ConnectChecklist({ steps, problem, problemState, busy = false, onRetry }: Props): JSX.Element {
  const danger = problemState === 'hostKeyChanged'
  const list = steps && steps.length > 0 ? steps : pendingSteps()
  return (
    <div className="server-checklist" data-testid="connect-checklist">
      <ol className="server-steps">
        {list.map((step) => {
          const Icon = STEP_ICON[step.state]
          return (
            <li key={step.id} className="server-step" data-step={step.id} data-state={step.state}>
              <Icon size={15} aria-label={STATE_LABEL[step.state]} className="server-step-icon" />
              <div className="server-step-body">
                <span className="server-step-text">{step.text}</span>
                {step.hint && <span className="server-step-hint">{step.hint}</span>}
              </div>
            </li>
          )
        })}
      </ol>
      {problem &&
        (danger ? (
          <p className="server-problem is-danger" data-testid="server-problem" role="alert">
            <ShieldAlert size={15} aria-hidden="true" className="server-problem-icon" />
            <span>{problem}</span>
          </p>
        ) : (
          <p className="server-problem" data-testid="server-problem">
            {problem}
          </p>
        ))}
      <div className="server-actions">
        <button type="button" className="btn btn-sm" data-testid="connect-retry" disabled={busy} onClick={onRetry}>
          Проверить снова
        </button>
      </div>
    </div>
  )
}
