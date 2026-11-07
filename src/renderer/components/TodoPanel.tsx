import type { TodoItem } from '../../shared/types'

const MARK: Record<string, string> = {
  completed: '✓',
  in_progress: '→',
  pending: '·'
}

/**
 * The agent's checklist, pinned above the ribbon.
 *
 * It is rewritten whole on every update, so putting it in the stream would
 * leave a trail of stale copies of the same list (spec 6.2).
 */
export function TodoPanel({ items }: { items: TodoItem[] }): JSX.Element {
  const done = items.filter((item) => item.status === 'completed').length

  return (
    <details className="todo-panel" data-testid="todo-panel" open>
      <summary>
        Задачи · {done} из {items.length}
      </summary>
      <ul>
        {items.map((item, index) => (
          <li key={`${index}-${item.content}`} data-testid="todo-item" className={`is-${item.status}`}>
            <span className="todo-mark" aria-hidden>
              {MARK[item.status] ?? '·'}
            </span>
            {item.content}
          </li>
        ))}
      </ul>
    </details>
  )
}
