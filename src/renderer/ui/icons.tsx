import { Bot, CircleAlert, FilePenLine, FileText, ListChecks, Plug, Search, SquareTerminal, Wrench } from 'lucide-react'
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
