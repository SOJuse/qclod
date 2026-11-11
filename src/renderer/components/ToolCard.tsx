import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, LoaderCircle } from 'lucide-react'
import { toolCategory } from '../../shared/toolCategory'
import { toolTitle } from '../../shared/toolTitle'
import { cardOutcome, toolView, type ToolCardItem, type ToolView } from '../../shared/toolView'
import { CategoryIcon } from '../ui/icons'
import { PathLink } from '../paths/PathLink'
import { useResolvedPaths } from '../paths/useResolvedPaths'
import { ToolBody } from './tool/ToolBody'
import './tool/Tool.css'

/**
 * The one thing the call was about: the command, the file, the query. A
 * search says what it looked for first and where second.
 */
function mainArg(
  item: ToolCardItem,
  view: ToolView
): { text: string; where?: string; mono: boolean; path?: string } {
  if (view.type === 'command' && view.command) return { text: view.command.split('\n')[0] ?? '', mono: true }
  const input = item.input ?? {}
  const pattern = typeof input['pattern'] === 'string' ? input['pattern'] : ''
  if (pattern && (item.name === 'Grep' || item.name === 'Glob')) {
    const where = typeof input['path'] === 'string' ? input['path'] : ''
    return { text: pattern, mono: false, ...(where ? { where } : {}) }
  }
  // The head shows a file by its name; the link opens the file at its full path.
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const path = input[key]
    if (typeof path === 'string' && path !== '') return { text: item.target, mono: false, path }
  }
  return { text: item.target, mono: false }
}

/**
 * One tool call.
 *
 * Folded, it is a single line: the category's rule and icon, what was done,
 * on what, and what came of it. Opened, it shows the details of that kind of
 * call. A failed call opens by itself: the error is what needs reading.
 * Colour marks only the icon chip and the rule; every word is in text colours.
 */
export function ToolCard({
  item,
  cwd,
  tabId,
  compact = false
}: {
  item: ToolCardItem
  cwd: string
  /** Whose folder the paths in the card are relative to. */
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

  const outcome = cardOutcome(item, view)
  const arg = mainArg(item, view)
  // A path is looked up once the call is done: a running one may still be creating it.
  const argPaths = useMemo(() => (arg.path && !running ? [arg.path] : []), [arg.path, running])
  const argTarget = useResolvedPaths(tabId, argPaths).get(arg.path ?? '')

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
        <span className="tool-chip">
          <CategoryIcon category={category} />
        </span>
        <span className="tool-name">{toolTitle(item.name)}</span>
        <span
          className={`tool-target${arg.mono ? ' tool-mono' : ''}`}
          title={arg.where ? `${arg.text} в ${arg.where}` : arg.text}
        >
          {argTarget ? (
            <PathLink tabId={tabId} target={argTarget}>
              {arg.text}
            </PathLink>
          ) : (
            arg.text
          )}
          {arg.where && <span className="tool-where"> в {arg.where}</span>}
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
      {open && <ToolBody item={item} view={view} cwd={cwd} tabId={tabId} />}
    </details>
  )
}
