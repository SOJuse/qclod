import { Component, type ErrorInfo, type ReactNode } from 'react'
import { StateView } from './StateView'
import './ErrorBoundary.css'

interface Props {
  scope: 'app' | 'pane'
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * A render error stays where it happened. React unmounts the whole tree when
 * nothing catches one, and the window turns blank; with a boundary around the
 * root, or around each pane, the rest stays alive and the person gets a button.
 * The error is also sent to the main process for the log.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      window.qclod.reportError({
        scope: this.props.scope,
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack ?? undefined
      })
    } catch (err) {
      // The bridge itself may be what broke; the console is all that is left.
      console.warn('[ErrorBoundary] could not report', err)
    }
  }

  private resetPane = (): void => this.setState({ error: null })
  private reloadWindow = (): void => void window.qclod.reloadWindow()

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const pane = this.props.scope === 'pane'
    return (
      <div className={`error-boundary is-${this.props.scope}`} data-testid={`error-boundary-${this.props.scope}`}>
        <StateView
          kind="error"
          title={pane ? 'В этой панели что-то сломалось' : 'Окно споткнулось'}
          hint={error.message}
          action={
            pane
              ? { label: 'Перезагрузить панель', onClick: this.resetPane }
              : { label: 'Перезагрузить окно', onClick: this.reloadWindow }
          }
        />
      </div>
    )
  }
}
