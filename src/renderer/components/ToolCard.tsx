import type { RibbonItem } from '../../shared/types'

type Tool = Extract<RibbonItem, { kind: 'tool' }>
type ToolError = Extract<RibbonItem, { kind: 'toolError' }>

/**
 * One line per tool call: what ran, on what, and how it went.
 *
 * Collapsed by default — a session makes hundreds of these and the point of
 * the ribbon is that you can read it. An error is the exception: it opens
 * itself, because a failure you have to click to see is a failure you miss.
 */
export function ToolCard({ item }: { item: Tool | ToolError }): JSX.Element {
  if (item.kind === 'toolError') {
    return (
      <div className="tool-card is-error">
        <div className="tool-head" data-testid="tool-head">
          <span className="tool-name">{item.name}</span>
          <span className="tool-target">{item.target}</span>
          <span className="tool-summary">ошибка</span>
        </div>
        <pre className="tool-detail" data-testid="tool-detail">
          {item.error}
        </pre>
      </div>
    )
  }

  return (
    <details className={`tool-card is-${item.state}`}>
      <summary className="tool-head" data-testid="tool-head">
        <span className="tool-name">{item.name}</span>
        <span className="tool-target">{item.target}</span>
        <span className="tool-summary">
          {item.state === 'running' ? 'работает…' : item.summary}
        </span>
      </summary>
      <pre className="tool-detail" data-testid="tool-detail">
        {item.detail}
      </pre>
    </details>
  )
}
