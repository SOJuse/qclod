import { useEffect, useRef } from 'react'
import { Brain, Image as ImageIcon } from 'lucide-react'
import { seconds } from '../../shared/format'
import type { Attachment, RibbonItem as Item } from '../../shared/types'
import { PermissionCard } from './PermissionCard'
import { PlanCard } from './PlanCard'
import { QuestionCard } from './QuestionCard'
import { NO_STEPS, SubagentCard } from './SubagentCard'
import { ToolCard } from './ToolCard'
import { Markdown } from '../markdown/Markdown'

interface Props {
  item: Item
  /** Every subagent's own items, by its id (childrenByParent), built once per render. */
  byParent: ReadonlyMap<string, Item[]>
  /** The tab's folder: where its commands run. */
  cwd: string
  tabId: string
  /** The permission the keys answer, if any. */
  activePermissionId?: string | null
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
          title="Открыть терминал, чтобы войти в Claude Code"
          onClick={() => void window.qclod.openTerminal()}
        >
          Войти
        </button>
      )}
    </div>
  )
}

type ImageAttachment = Extract<Attachment, { kind: 'image' }>

/**
 * A picture the user sent, as a thumbnail. One with a copy in userData/pastes
 * opens in the default viewer on click; one from an older session has only
 * its bytes and is just shown.
 */
function UserImage({ image, tabId }: { image: ImageAttachment; tabId: string }): JSX.Element {
  const src = image.thumbnail ?? (image.dataBase64 ? `data:${image.mediaType};base64,${image.dataBase64}` : '')
  const size = image.width && image.height ? ` ${image.width}×${image.height}` : ''
  const picture = src ? <img src={src} alt={`Снимок${size}`} /> : <ImageIcon size={20} aria-hidden="true" />
  const path = image.path
  if (!path) {
    return (
      <span className="row-user-image" data-testid="row-user-image" title={`Снимок${size}`}>
        {picture}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="row-user-image is-openable"
      data-testid="row-user-image"
      title={`Открыть снимок${size}`}
      onClick={() => void window.qclod.openPath(tabId, path)}
    >
      {picture}
    </button>
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
  byParent,
  cwd,
  tabId,
  activePermissionId = null,
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
            {item.attachments.some((a) => a.kind === 'image') && (
              <div className="row-user-images">
                {item.attachments.map((a, i) =>
                  a.kind === 'image' ? <UserImage key={i} image={a} tabId={tabId} /> : null
                )}
              </div>
            )}
            {item.attachments.some((a) => a.kind === 'file') && (
              <div className="row-user-files">
                {item.attachments.map((a, i) =>
                  a.kind === 'file' ? (
                    <span key={i} className="row-chip">
                      {a.path.split(/[\\/]/).pop()}
                    </span>
                  ) : null
                )}
              </div>
            )}
          </div>
        )

      case 'agentText':
        return (
          <div className={`row-agent${item.streaming ? ' is-streaming' : ''}`}>
            <Markdown text={item.text} tabId={tabId} streaming={item.streaming} />
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
          <SubagentCard
            item={item}
            steps={byParent.get(item.id) ?? NO_STEPS}
            byParent={byParent}
            cwd={cwd}
            tabId={tabId}
          />
        )

      case 'plan':
        return <PlanCard item={item} onAnswer={onAnswerPlan} />

      case 'permission':
        return (
          <PermissionCard
            item={item}
            active={item.id === activePermissionId}
            onAnswer={onAnswerPermission}
          />
        )

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
