import { Bot, Brain, CircleAlert, CircleHelp, FilePenLine, FileText, ListChecks, OctagonAlert, PenLine, Plug, Search, SquareTerminal, TriangleAlert, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ContextLevel } from '../chat/contextLevel'
import type { ToolCategory } from '@shared/toolCategory'

export const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  read: FileText,
  search: Search,
  edit: FilePenLine,
  command: SquareTerminal,
  agent: Bot,
  mcp: Plug,
  plan: ListChecks,
  other: Wrench
}

/**
 * The live line's states that are not a tool call. Thinking and writing are
 * the agent's own work, so they stay quiet; waiting is on the user and wears
 * the plan colour. None of them is a tool category.
 */
export const NOW_ICON: Record<'thinking' | 'writing' | 'waiting', { icon: LucideIcon; color: string }> = {
  thinking: { icon: Brain, color: 'var(--text-dim)' },
  writing: { icon: PenLine, color: 'var(--text-dim)' },
  waiting: { icon: CircleHelp, color: 'var(--cat-plan)' }
}

export const ERROR_ICON: LucideIcon = CircleAlert

/** One size for every control in the window chrome, so no button looks smaller than its neighbours. */
export const CHROME_ICON_SIZE = 14

/**
 * Warn and critical differ by shape, not only colour: a triangle says
 * «take note», an octagon (a stop sign) says «act now».
 */
export const LEVEL_ICON: Record<'warn' | 'critical', LucideIcon> = {
  warn: TriangleAlert,
  critical: OctagonAlert
}

/** What the level icon says to a screen reader and on hover: every status ships with a label. */
export const LEVEL_LABEL: Record<'context' | 'limit', Record<'warn' | 'critical', string>> = {
  context: { warn: 'Контекст заполняется', critical: 'Контекст почти заполнен' },
  limit: { warn: 'Лимит близко', critical: 'Лимит почти исчерпан' }
}

/** The level's own icon; nothing at `ok`, where there is nothing to notice. */
export function LevelIcon({
  level,
  label,
  size = 13
}: {
  level: ContextLevel
  label: string
  size?: number
}): JSX.Element | null {
  if (level === 'ok') return null
  const Icon = LEVEL_ICON[level]
  return <Icon size={size} color={`var(--status-${level})`} role="img" aria-label={label} data-level-icon={level} />
}

export function CategoryIcon({
  category,
  error,
  size = 14
}: {
  category: ToolCategory
  error?: boolean
  size?: number
}): JSX.Element {
  const Icon = error ? ERROR_ICON : CATEGORY_ICON[category]
  return <Icon size={size} color={error ? 'var(--status-critical)' : `var(--cat-${category})`} aria-hidden="true" />
}
