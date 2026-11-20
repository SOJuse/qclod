import { SquarePen } from 'lucide-react'
import { useState } from 'react'
import { hint } from '../../app/shortcuts'
import type { SidebarProject } from '../../chat/sidebarModel'
import type { SessionSummary, TabId } from '../../../shared/types'
import { PAST_FIRST, PAST_STEP, ProjectGroup } from './ProjectGroup'
import './Sidebar.css'

export interface SidebarProps {
  projects: SidebarProject[]
  activeTabId: TabId
  /** The chats shown in the split's panes. */
  paneTabIds: TabId[]
  onActivate: (id: TabId) => void
  onClose: (id: TabId) => void
  /** With a folder, a new chat there; without one, the folder is asked for. */
  onNewChat: (cwd?: string) => void
  onOpenPast: (cwd: string, session: SessionSummary) => void
  onToggleProject: (cwd: string, collapsed: boolean) => void
  onForget: (cwd: string) => void
  /** «Повторить» under a history that could not be read. */
  onRetryPast: (cwd: string) => void
  /** «Показать ещё» was pressed; the sidebar itself shows the next rows. */
  onMore?: (cwd: string) => void
}

/**
 * The left column: projects, each with its open chats on top and its past
 * conversations below. The order of the chats here is the order of Ctrl+Tab
 * and Ctrl+1…9.
 */
export function Sidebar({
  projects,
  activeTabId,
  paneTabIds,
  onActivate,
  onClose,
  onNewChat,
  onOpenPast,
  onToggleProject,
  onForget,
  onRetryPast,
  onMore
}: SidebarProps): JSX.Element {
  /** How many past conversations each project shows, by project key; PAST_FIRST until «Показать ещё». */
  const [shown, setShown] = useState<Record<string, number>>({})

  return (
    <nav className="sidebar" data-testid="sidebar" aria-label="Проекты и чаты">
      <div className="sidebar-head">
        <button
          type="button"
          className="sidebar-new"
          data-testid="tab-new"
          title={hint('Новый чат в другой папке', 'newTab')}
          onClick={() => onNewChat()}
        >
          <SquarePen size={14} aria-hidden="true" />
          Новый чат
        </button>
      </div>
      <div className="sidebar-list">
        {projects.map((project) => (
          <ProjectGroup
            key={project.key}
            project={project}
            activeTabId={activeTabId}
            paneTabIds={paneTabIds}
            shown={shown[project.key] ?? PAST_FIRST}
            onActivate={onActivate}
            onClose={onClose}
            onNewChat={onNewChat}
            onOpenPast={onOpenPast}
            onToggle={(collapsed) => onToggleProject(project.cwd, collapsed)}
            onForget={() => onForget(project.cwd)}
            onRetryPast={() => onRetryPast(project.cwd)}
            onMore={() => {
              setShown((all) => ({ ...all, [project.key]: (all[project.key] ?? PAST_FIRST) + PAST_STEP }))
              onMore?.(project.cwd)
            }}
          />
        ))}
      </div>
    </nav>
  )
}
