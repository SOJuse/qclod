import { Brain } from 'lucide-react'
import { seconds } from '../../shared/format'
import type { RibbonItem } from '../../shared/types'

type Thinking = Extract<RibbonItem, { kind: 'thinking' }>

/** «Думал 12 с»; a block that came whole has no length to print. «Думает…» while it streams. */
function thinkingLabel(item: Thinking): string {
  if (!item.done) return 'Думает…'
  return item.durationMs >= 100 ? `Думал ${seconds(item.durationMs)}` : 'Думал'
}

/** Folded while it streams and after: the text is there for whoever wants it. */
export function ThinkingRow({ item }: { item: Thinking }): JSX.Element {
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
}
