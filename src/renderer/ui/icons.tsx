import { Bot, Brain, CircleAlert, CircleHelp, FilePenLine, FileText, ListChecks, PenLine, Plug, Search, SquareTerminal, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
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
