import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { RowModel } from '../chat/groupRows'
import { groupLabel } from '../chat/groupRows'
import { CategoryIcon } from '../ui/icons'
import { ThinkingRow } from './ThinkingRow'
import { ToolCard } from './ToolCard'

/**
 * A run of one kind of call, folded to a line: «Прочитал 12 файлов». Opened,
 * it shows each call as its own card, with the thinking between them.
 */
export function ToolGroup({
  group,
  cwd,
  tabId
}: {
  group: Extract<RowModel, { kind: 'toolGroup' }>
  cwd: string
  tabId: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="tool-group" data-testid="tool-group" data-category={group.category}>
      <button
        type="button"
        className="tool-group-toggle"
        data-testid="tool-group-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={14} className="tool-group-chevron" aria-hidden="true" />
        <CategoryIcon category={group.category} />
        <span className="tool-group-label">{groupLabel(group.category, group.count, group.running, group.errors)}</span>
      </button>
      {open && (
        <div className="tool-group-body">
          {group.items.map((item) =>
            item.kind === 'thinking' ? (
              <ThinkingRow key={item.id} item={item} />
            ) : item.kind === 'tool' || item.kind === 'toolError' ? (
              <ToolCard key={item.id} item={item} cwd={cwd} tabId={tabId} />
            ) : null
          )}
        </div>
      )}
    </div>
  )
}
