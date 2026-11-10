import { useState } from 'react'
import type { ToolCardItem } from '../../../shared/toolView'

/**
 * The call as the agent made it and the answer as the tool gave it, for when
 * the structured view leaves something out. Built only when opened: a session
 * has hundreds of cards and almost nobody looks here.
 */
export function RawJson({ item }: { item: ToolCardItem }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <details className="tool-raw" data-testid="tool-raw" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Вход и выход как есть</summary>
      {open && <pre className="tool-pre">{raw(item)}</pre>}
    </details>
  )
}

function raw(item: ToolCardItem): string {
  const result = item.kind === 'tool' ? item.detail : item.error
  const shown = {
    input: item.input ?? {},
    ...(item.output === undefined ? { result } : { output: item.output })
  }
  return JSON.stringify(shown, null, 2)
}
