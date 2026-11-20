import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, Image as ImageIcon, Smartphone } from 'lucide-react'
import { clockTime, seconds } from '../../shared/format'
import type { Attachment, RibbonItem as Item } from '../../shared/types'
import type { CardAnswers } from '../chat/cardAnswers'
import { PermissionCard } from './PermissionCard'
import { PlanCard } from './PlanCard'
import { QuestionCard } from './QuestionCard'
import { NO_STEPS, SubagentCard } from './SubagentCard'
import { ToolCard } from './ToolCard'
import { Markdown } from '../markdown/Markdown'
import { ERROR_ICON } from '../ui/icons'
import { PIECE, mostlyCyrillic, textPieces } from '../ui/longText'

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
  /** How the cards answer the agent. */
  answers: CardAnswers
}

/** «Думал 12 с»; a block that came whole has no length to print. «Думает…» while it streams. */
function thinkingLabel(item: Extract<Item, { kind: 'thinking' }>): string {
  if (!item.done) return 'Думает…'
  return item.durationMs >= 100 ? `Думал ${seconds(item.durationMs)}` : 'Думал'
}

/**
 * Something Qclod itself says. A notice about logging in carries the way to
 * do it: the same login window the setup screen opens. If that window could
 * not be opened, the reason shows under the notice instead of nothing.
 */
export function NoticeRow({
  item,
  tabId
}: {
  item: Extract<Item, { kind: 'notice' }>
  tabId?: string
}): JSX.Element {
  const [loginError, setLoginError] = useState<string | null>(null)

  async function login(): Promise<void> {
    setLoginError(null)
    try {
      await window.qclod.login()
    } catch (err) {
      // Electron wraps the main side's message; only the reason is worth showing.
      const message = err instanceof Error ? err.message : String(err)
      setLoginError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <div className={`row-notice is-${item.tone}`}>
      {item.text}
      {item.action === 'login' && (
        <button
          type="button"
          className="row-notice-action"
          data-testid="notice-login"
          title="Откроется окно входа"
          onClick={() => void login()}
        >
          Войти
        </button>
      )}
      {item.action === 'terminal' && tabId && (
        <button
          type="button"
          className="row-notice-action"
          data-testid="notice-terminal"
          title="Откроется окно терминала с Claude Code в папке этой вкладки"
          onClick={() => void window.qclod.openTerminal(tabId)}
        >
          Открыть терминал
        </button>
      )}
      {item.action === 'login' && loginError && (
        <div className="row-notice-error" data-testid="notice-login-error" role="alert">
          <ERROR_ICON size={13} aria-hidden="true" />
          <span>Не удалось открыть окно входа: {loginError}</span>
        </div>
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
  return <OpenableImage path={path} tabId={tabId} size={size} picture={picture} />
}

/** A thumbnail whose copy is opened on click; a copy cleaned up since says so. */
function OpenableImage({
  path,
  tabId,
  size,
  picture
}: {
  path: string
  tabId: string
  size: string
  picture: JSX.Element
}): JSX.Element {
  const [gone, setGone] = useState(false)
  return (
    <span className="row-user-image-wrap">
      <button
        type="button"
        className="row-user-image is-openable"
        data-testid="row-user-image"
        title={`Открыть снимок${size}`}
        onClick={() =>
          void window.qclod.openPath(tabId, path).then((result) => setGone(result === null))
        }
      >
        {picture}
      </button>
      {gone && (
        <span className="row-user-image-gone" data-testid="row-user-image-gone" role="status">
          Файл уже удалён
        </span>
      )}
    </span>
  )
}

/**
 * What the person wrote, whole. A long text goes in pieces, each its own text
 * node, so that one long paragraph is not laid out in quadratic time
 * (ui/longText.ts); a long Russian one takes Inter's Cyrillic file for its
 * spaces too (styles/longText.css). It reads, wraps and copies as one.
 */
function UserText({ text }: { text: string }): JSX.Element {
  const pieces = useMemo(() => (text.length > PIECE ? textPieces(text) : null), [text])
  const cyrillic = useMemo(() => pieces !== null && mostlyCyrillic(text), [pieces, text])
  return (
    <div className={cyrillic ? 'row-user-text is-cyrillic' : 'row-user-text'}>
      {pieces ? pieces.map((piece, i) => <span key={i}>{piece}</span>) : text}
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
  byParent,
  cwd,
  tabId,
  activePermissionId = null,
  onMeasure,
  answers
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
            {item.remote && (
              <div
                className="row-user-from"
                data-testid="user-from-phone"
                title="Написано через Remote Control — с телефона или claude.ai"
              >
                <Smartphone size={12} aria-hidden="true" />
                с телефона
              </div>
            )}
            <UserText text={item.text} />
            {item.at !== undefined && (
              <div
                className="row-user-time"
                data-testid="user-time"
                title={`Отправлено ${new Date(item.at).toLocaleString('ru-RU')}`}
              >
                {clockTime(item.at)}
              </div>
            )}
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
        return (
          <PlanCard item={item} onAnswer={(requestId, approve) => answers.plan(requestId, { approve })} />
        )

      case 'permission':
        return (
          <PermissionCard
            item={item}
            active={item.id === activePermissionId}
            onAnswer={(requestId, behavior, remember) =>
              answers.permission(
                requestId,
                behavior === 'allow'
                  ? { behavior: 'allow', scope: remember ? 'always' : 'once' }
                  : { behavior: 'deny' }
              )
            }
          />
        )

      case 'question':
        return (
          <QuestionCard
            item={item}
            onAnswer={(toolUseId, given) => answers.question(toolUseId, given, {})}
          />
        )

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
        return <NoticeRow item={item} tabId={tabId} />

      case 'turnEnd':
        return (
          <div
            className={`row-turn-end${item.failed ? ' is-failed' : ''}`}
            data-testid="turn-end"
            title={new Date(item.at).toLocaleString('ru-RU')}
          >
            {item.failed ? 'Остановлен' : 'Готово'} в {clockTime(item.at)}
            {item.durationMs ? ` · ${seconds(item.durationMs)}` : ''}
          </div>
        )

      default:
        return <div />
    }
  }
}
