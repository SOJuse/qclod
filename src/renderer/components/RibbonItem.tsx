import { useEffect, useRef } from 'react'
import { Brain } from 'lucide-react'
import { compactNumber, plural, seconds } from '../../shared/format'
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
  /** The tab's folder: where its commands run. */
  cwd: string
  tabId: string
  onMeasure: (id: string, height: number) => void
  onAnswerPermission: (requestId: string, behavior: 'allow' | 'deny', remember?: boolean) => void
  onAnswerQuestion: (toolUseId: string, answers: Record<string, string>) => void
  onAnswerPlan: (requestId: string, approve: boolean) => void
}

/** «Думал 12 с»; a block that came whole has no length to print. «Думает…» while it streams. */
function thinkingLabel(item: Extract<Item, { kind: 'thinking' }>): string {
  if (!item.done) return 'Думает…'
  return item.durationMs >= 100 ? `Думал ${seconds(item.durationMs)}` : 'Думал'
}

/**
 * Something Qclod itself says. A notice about logging in carries the way to
 * do it: the same terminal the setup screen opens.
 */
export function NoticeRow({ item }: { item: Extract<Item, { kind: 'notice' }> }): JSX.Element {
  return (
    <div className={`row-notice is-${item.tone}`}>
      {item.text}
      {item.action === 'login' && (
        <button
          type="button"
          className="row-notice-action"
          data-testid="notice-login"
          onClick={() => void window.qclod.openTerminal()}
        >
          Войти
        </button>
      )}
    </div>
  )
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
  cwd,
  tabId,
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
          <details className="thinking">
            <summary className="thinking-head" data-testid="thinking-head">
              <Brain size={14} aria-hidden="true" />
              {thinkingLabel(item)}
            </summary>
            <div className="thinking-text" data-testid="thinking-text">
              {item.text}
            </div>
          </details>
        )

      case 'tool':
      case 'toolError':
        return <ToolCard item={item} cwd={cwd} tabId={tabId} />

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
                    item.durationMs ? seconds(item.durationMs) : null,
                    item.tokens ? `${compactNumber(item.tokens)} токенов` : null,
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
                    <ToolCard item={child} cwd={cwd} tabId={tabId} compact />
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
          <div>
            <div className="row-compaction">
              <span>
                контекст сжат{item.trigger === 'manual' ? ' вручную' : ''} · освободилось{' '}
                {item.freedTokens.toLocaleString('ru-RU')} токенов
              </span>
            </div>
            {item.summary ? (
              <details className="row-compaction-summary">
                <summary>Что было до сжатия</summary>
                <div className="row-compaction-text">{item.summary}</div>
              </details>
            ) : null}
          </div>
        )

      case 'notice':
        return <NoticeRow item={item} />

      default:
        return <div />
    }
  }
}
