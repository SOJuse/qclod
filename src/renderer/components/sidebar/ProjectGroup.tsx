import { ChevronRight, Ellipsis, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SidebarProject } from '../../chat/sidebarModel'
import type { SessionSummary, TabId } from '../../../shared/types'
import { reasonOf } from '../../ui/StateView'
import { ChatRow } from './ChatRow'
import { PastRow } from './PastRow'

/** How many past conversations a project shows at first, and how many more each «Показать ещё» adds. */
export const PAST_FIRST = 5
export const PAST_STEP = 20

interface Props {
  project: SidebarProject
  activeTabId: TabId
  paneTabIds: TabId[]
  /** How many past conversations are shown. */
  shown: number
  onActivate: (id: TabId) => void
  onClose: (id: TabId) => void
  onNewChat: (cwd: string) => void
  onOpenPast: (cwd: string, session: SessionSummary) => void
  onToggle: (collapsed: boolean) => void
  onForget: () => void
  onRetryPast: () => void
  onMore: () => void
}

/**
 * One project: its row (fold, «+», menu), then its open chats, then its past
 * conversations. A folded project is its row alone.
 */
export function ProjectGroup({
  project,
  activeTabId,
  paneTabIds,
  shown,
  onActivate,
  onClose,
  onNewChat,
  onOpenPast,
  onToggle,
  onForget,
  onRetryPast,
  onMore
}: Props): JSX.Element {
  const { cwd, name, collapsed, chats, past, remote } = project
  const fold = collapsed ? `Развернуть ${name}` : `Свернуть ${name}`
  return (
    <div className="project-group">
      <div
        data-testid="project"
        data-key={project.key}
        className="project-row"
        title={cwd}
        // The name folds too; the buttons in the row do their own thing.
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('button')) onToggle(!collapsed)
        }}
      >
        <button
          type="button"
          className="project-toggle"
          data-testid="project-toggle"
          aria-expanded={!collapsed}
          aria-label={fold}
          title={fold}
          onClick={() => onToggle(!collapsed)}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        <span className="project-name">{name}</span>
        {remote && (
          <span className="project-remote" data-testid="project-remote" data-color={remote.color}>
            {remote.label}
          </span>
        )}
        <button
          type="button"
          className="project-action"
          data-testid="project-new-chat"
          aria-label={`Новый чат в ${name}`}
          title={`Новый чат в ${name}`}
          onClick={() => onNewChat(cwd)}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
        {chats.length === 0 && <ProjectMenu name={name} onForget={onForget} />}
      </div>

      {!collapsed && (
        <>
          {chats.map((tab) => (
            <ChatRow
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              inPane={paneTabIds.includes(tab.id)}
              onActivate={onActivate}
              onClose={onClose}
            />
          ))}
          <PastList
            cwd={cwd}
            past={past}
            shown={shown}
            onOpen={(s) => onOpenPast(cwd, s)}
            onRetry={onRetryPast}
            onMore={onMore}
          />
        </>
      )}
    </div>
  )
}

function PastList({
  cwd,
  past,
  shown,
  onOpen,
  onRetry,
  onMore
}: {
  cwd: string
  past: SidebarProject['past']
  shown: number
  onOpen: (session: SessionSummary) => void
  onRetry: () => void
  onMore: () => void
}): JSX.Element | null {
  if (past === null) return null
  if (past === 'loading') {
    return (
      <p className="sidebar-note" data-state="loading" role="status">
        Загружаю…
      </p>
    )
  }
  if (!Array.isArray(past)) {
    return (
      <div className="sidebar-note is-error" data-state="error" role="alert">
        <span>Не удалось прочитать историю</span>
        {/* Without Electron's «Error invoking remote method» wrapping. */}
        <span className="sidebar-note-why">{reasonOf(past.error)}</span>
        <button type="button" className="sidebar-link" title="Повторить" onClick={onRetry}>
          Повторить
        </button>
      </div>
    )
  }
  if (past.length === 0) return null
  return (
    <>
      <div className="sidebar-past-head" data-testid="sidebar-past-head">
        Прошлые
      </div>
      {past.slice(0, shown).map((session) => (
        <PastRow key={session.id} cwd={cwd} session={session} onOpen={onOpen} />
      ))}
      {past.length > shown && (
        <button
          type="button"
          className="sidebar-link sidebar-more"
          data-testid="sidebar-more"
          title="Показать ещё"
          onClick={onMore}
        >
          Показать ещё
        </button>
      )}
    </>
  )
}

/** «…» on a project with no open chats: one item, «Убрать из списка». */
function ProjectMenu({ name, onForget }: { name: string; onForget: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)

  // A press anywhere else closes it.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])

  return (
    <div
      ref={box}
      className="project-menu-box"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          setOpen(false)
          button.current?.focus()
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="project-action"
        data-testid="project-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Меню проекта ${name}`}
        title={`Меню проекта ${name}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      <div className="project-menu-list" role="menu" hidden={!open}>
        <button
          type="button"
          role="menuitem"
          className="project-menu-item"
          data-testid="project-forget"
          title="Убрать из списка"
          onClick={() => {
            setOpen(false)
            onForget()
          }}
        >
          Убрать из списка
        </button>
      </div>
    </div>
  )
}
