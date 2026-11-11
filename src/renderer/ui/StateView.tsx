import { CircleAlert, Inbox, LoaderCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import './StateView.css'

type StateKind = 'loading' | 'empty' | 'error'

const ICON: Record<StateKind, LucideIcon> = {
  loading: LoaderCircle,
  empty: Inbox,
  error: CircleAlert
}

interface Props {
  kind: StateKind
  title: string
  hint?: string
  action?: { label: string; onClick: () => void }
  testId?: string
}

/**
 * What a screen shows while it has nothing to show: still loading, nothing
 * there, or it could not be read. One look everywhere: a small icon, a line
 * saying what is going on, a dim line saying why, and at most one button.
 * Loading and empty are announced politely; an error is announced at once.
 */
export function StateView({ kind, title, hint, action, testId }: Props): JSX.Element {
  const Icon = ICON[kind]
  return (
    <div
      className={`state-view is-${kind}`}
      data-state={kind}
      data-testid={testId}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <Icon className="state-view-icon" size={16} aria-hidden="true" />
      <div className="state-view-text">
        <p className="state-view-title">{title}</p>
        {hint && <p className="state-view-hint">{hint}</p>}
      </div>
      {action && (
        <button type="button" className="state-view-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}

/** The reason a rejected IPC call gives, without Electron's «Error invoking remote method» wrapping. */
export function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
