import { useEffect, useRef } from 'react'
import type { RibbonItem as Item } from '../../shared/types'
import { AGENT_STATE_LABEL } from './agentState'
import { PermissionCard } from './PermissionCard'
import { PlanCard } from './PlanCard'
import { QuestionCard } from './QuestionCard'
import { ToolCard } from './ToolCard'
import { Markdown } from '../markdown/Markdown'

interface Props {
  item: Item
  children: Item[]
  onMeasure: (id: string, height: number) => void
  onAnswerPermission: (requestId: string, behavior: 'allow' | 'deny', remember?: boolean) => void
  onAnswerQuestion: (toolUseId: string, choice: string) => void
  onAnswerPlan: (requestId: string, approve: boolean) => void
}

/** «42 с», «3 мин 20 с» — a length a person reads, not milliseconds. */
function duration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} с`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`
}

/** 15000 → «15k»: the magnitude is what matters, not the digits. */
function compact(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return many
  if (ones === 1) return one
  if (ones >= 2 && ones <= 4) return few
  return many
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
  onAnswerQuestion,
  onAnswerPlan
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
          <div className={`row-agent${item.streaming ? ' is-streaming' : ''}`}>
            <Markdown text={item.text} />
          </div>
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
          <details className={`row-subagent is-${item.state}`}>
            <summary data-testid="subagent-head">
              <span className="row-subagent-kind">{item.name}</span>
              <span className="row-subagent-task">{item.task}</span>
              <span className="row-subagent-stats" data-testid="subagent-stats">
                {item.state === 'running' ? (
                  <span className="row-subagent-working">
                    {AGENT_STATE_LABEL.running}
                    {item.lastTool ? ` · ${item.lastTool}` : '…'}
                  </span>
                ) : item.state === 'failed' || item.state === 'unfinished' || item.state === 'stopped' ? (
                  <span className="row-subagent-failed">
                    {AGENT_STATE_LABEL[item.state]}
                    {item.state === 'failed' && item.summary ? ` · ${item.summary}` : ''}
                  </span>
                ) : (
                  [
                    item.durationMs ? duration(item.durationMs) : null,
                    item.tokens ? `${compact(item.tokens)} токенов` : null,
                    item.toolCalls ? `${item.toolCalls} ${plural(item.toolCalls, 'вызов', 'вызова', 'вызовов')}` : null,
                    `${children.length} в ленте`
                  ]
                    .filter(Boolean)
                    .join(' · ')
                )}
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

      case 'plan':
        return <PlanCard item={item} onAnswer={onAnswerPlan} />

      case 'permission':
        return <PermissionCard item={item} onAnswer={onAnswerPermission} />

      case 'question':
        return <QuestionCard item={item} onAnswer={onAnswerQuestion} />

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
