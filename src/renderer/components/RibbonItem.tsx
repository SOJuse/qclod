import { useEffect, useRef } from 'react'
import type { RibbonItem as Item } from '../../shared/types'
import { ToolCard } from './ToolCard'

interface Props {
  item: Item
  children: Item[]
  onMeasure: (id: string, height: number) => void
  onAnswerPermission: (requestId: string, behavior: 'allow' | 'deny', remember?: boolean) => void
  onAnswerQuestion: (toolUseId: string, choice: string) => void
}

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  const tens = s % 100
  const ones = s % 10
  if (tens >= 11 && tens <= 14) return `${s} секунд`
  if (ones === 1) return `${s} секунду`
  if (ones >= 2 && ones <= 4) return `${s} секунды`
  return `${s} секунд`
}

/**
 * One row of the conversation.
 *
 * Reports its own height so the ribbon can place the rows above and below it
 * without rendering them: a row that streams keeps growing, and the list has
 * to follow it rather than assume a size.
 */
export function RibbonRow({
  item,
  children,
  onMeasure,
  onAnswerPermission,
  onAnswerQuestion
}: Props): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const report = (): void => onMeasure(item.id, el.getBoundingClientRect().height)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  })

  return (
    <div className="ribbon-row" ref={host} data-testid={`ribbon-${item.kind}`}>
      {render()}
    </div>
  )

  function render(): JSX.Element {
    switch (item.kind) {
      case 'user':
        return (
          <div className="row-user">
            <div className="row-user-text">{item.text}</div>
            {item.attachments.length > 0 && (
              <div className="row-user-files">
                {item.attachments.map((a, i) => (
                  <span key={i} className="row-chip">
                    {a.kind === 'file' ? a.path.split(/[\\/]/).pop() : 'изображение'}
                  </span>
                ))}
              </div>
            )}
          </div>
        )

      case 'agentText':
        return (
          <div className={`row-agent${item.streaming ? ' is-streaming' : ''}`}>{item.text}</div>
        )

      case 'thinking':
        return (
          <details className="row-thinking">
            <summary data-testid="thinking-head">
              {item.done ? `думал ${seconds(item.durationMs)}` : 'думает…'}
            </summary>
            <div className="row-thinking-text" data-testid="thinking-text">
              {item.text}
            </div>
          </details>
        )

      case 'tool':
      case 'toolError':
        return <ToolCard item={item} />

      case 'subagent':
        return (
          <details className="row-subagent">
            <summary data-testid="subagent-head">
              <span className="row-subagent-name">{item.name}</span>
              <span className="row-subagent-summary">
                {item.state === 'running' ? 'работает…' : item.summary}
              </span>
            </summary>
            <div className="row-subagent-body">
              {children.map((child) => (
                <div key={child.id} data-testid={`ribbon-${child.kind}`}>
                  {child.kind === 'tool' || child.kind === 'toolError' ? (
                    <ToolCard item={child} />
                  ) : child.kind === 'agentText' ? (
                    <div className="row-agent">{child.text}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        )

      case 'permission':
        return (
          <div className={`row-permission is-${item.state}`} data-testid="permission-card">
            <div className="row-permission-head">
              <strong>{item.toolName}</strong>
              <span className="row-permission-target">{item.target}</span>
            </div>
            {item.state === 'pending' ? (
              <div className="row-permission-actions">
                <button
                  type="button"
                  data-testid="permission-allow"
                  onClick={() => onAnswerPermission(item.requestId, 'allow')}
                >
                  Разрешить
                </button>
                <button
                  type="button"
                  data-testid="permission-allow-all"
                  onClick={() => onAnswerPermission(item.requestId, 'allow', true)}
                >
                  Разрешить всё такое
                </button>
                <button
                  type="button"
                  data-testid="permission-deny"
                  onClick={() => onAnswerPermission(item.requestId, 'deny')}
                >
                  Отклонить
                </button>
              </div>
            ) : (
              <div className="row-permission-done">
                {item.state === 'allowed' ? 'разрешено' : 'отклонено'}
              </div>
            )}
          </div>
        )

      case 'question':
        return (
          <div className="row-question" data-testid="question-card">
            <div className="row-question-text">{item.question}</div>
            <div className="row-question-options">
              {item.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  data-testid="question-option"
                  className={item.answer === option ? 'is-chosen' : ''}
                  disabled={item.answer !== null}
                  onClick={() => onAnswerQuestion(item.toolUseId, option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        )

      case 'compaction':
        return (
          <div className="row-compaction">
            <span>
              контекст сжат{item.trigger === 'manual' ? ' вручную' : ''} · освободилось{' '}
              {item.freedTokens.toLocaleString('ru-RU')} токенов
            </span>
          </div>
        )

      case 'notice':
        return <div className={`row-notice is-${item.tone}`}>{item.text}</div>

      default:
        return <div />
    }
  }
}
