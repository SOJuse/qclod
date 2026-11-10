import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, LoaderCircle } from 'lucide-react'
import { mcpParts, toolCategory } from '../../shared/toolCategory'
import { toolOutcome, toolView, type ToolCardItem, type ToolView } from '../../shared/toolView'
import { CategoryIcon } from '../ui/icons'
import { ToolBody } from './tool/ToolBody'
import './tool/Tool.css'

/** What a call is, in the words a person uses; MCP and unknown tools are named in the head itself. */
const TOOL_TITLE: Record<string, string> = {
  Read: 'Чтение',
  Edit: 'Правка',
  Write: 'Запись',
  Bash: 'Команда',
  Grep: 'Поиск',
  Glob: 'Поиск файлов',
  WebFetch: 'Страница',
  WebSearch: 'Поиск в сети'
}

function title(name: string): string {
  const mcp = mcpParts(name)
  if (mcp) return `${mcp.server} · ${mcp.tool}`
  return TOOL_TITLE[name] ?? name
}

/** The one thing the call was about: the command, the file, the query. */
function mainArg(item: ToolCardItem, view: ToolView): { text: string; mono: boolean } {
  if (view.type === 'command' && view.command) return { text: view.command.split('\n')[0] ?? '', mono: true }
  if (item.name === 'Bash' && typeof item.input?.['command'] === 'string') {
    return { text: item.input['command'].split('\n')[0] ?? '', mono: true }
  }
  return { text: item.target, mono: false }
}

/**
 * One tool call.
 *
 * Folded, it is a single line: the category's rule and icon, what was done,
 * on what, and what came of it. Opened, it shows the details of that kind of
 * call. A failed call opens by itself: the error is what needs reading.
 * Colour marks only the icon and the rule; every word is in text colours.
 */
export function ToolCard({
  item,
  cwd,
  compact = false
}: {
  item: ToolCardItem
  cwd: string
  /** Used by PathLink (Task 11) to ask the tab's session about paths. */
  tabId: string
  compact?: boolean
}): JSX.Element {
  const failed = item.kind === 'toolError'
  const running = item.kind === 'tool' && item.state === 'running'
  const category = toolCategory(item.name)
  const view = useMemo(() => toolView(item), [item])
  const [open, setOpen] = useState(failed)

  // A call can fail after its card is on screen; the error opens it then.
  useEffect(() => {
    if (failed) setOpen(true)
  }, [failed])

  const outcome = running
    ? ''
    : view.type === 'generic' && item.kind === 'tool' && item.summary
      ? item.summary
      : toolOutcome(item, view)
  const arg = mainArg(item, view)

  const classes = ['tool-card', failed ? 'is-error' : running ? 'is-running' : 'is-done']
  if (compact) classes.push('is-compact')

  return (
    <details
      className={classes.join(' ')}
      data-category={category}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="tool-head" data-testid="tool-head">
        <span className="tool-icon">
          <CategoryIcon category={category} />
        </span>
        <span className="tool-name">{title(item.name)}</span>
        <span className={`tool-target${arg.mono ? ' tool-mono' : ''}`} title={arg.text}>
          {arg.text}
        </span>
        {outcome && <span className="tool-outcome">{outcome}</span>}
        {running && (
          <span className="tool-status" role="img" aria-label="идёт">
            <LoaderCircle size={14} className="tool-spin" aria-hidden="true" />
          </span>
        )}
        {failed && (
          <span className="tool-status" role="img" aria-label="ошибка">
            <CircleAlert size={14} color="var(--status-critical)" aria-hidden="true" />
          </span>
        )}
      </summary>
      {open && <ToolBody item={item} view={view} cwd={cwd} />}
    </details>
  )
}
