import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Circle, ListChecks, LoaderCircle } from 'lucide-react'
import type { SessionStatus, TodoItem } from '../../shared/types'
import './TodoStrip.css'

interface Props {
  items: TodoItem[]
  status: SessionStatus
}

function Mark({ status }: { status: string }): JSX.Element {
  if (status === 'completed') return <Check size={14} className="todo-mark is-done" aria-label="Готово" />
  if (status === 'in_progress') return <LoaderCircle size={14} className="todo-mark is-doing" aria-label="Идёт" />
  return <Circle size={14} className="todo-mark is-waiting" aria-label="Ждёт" />
}

/**
 * The agent's checklist as a thin strip above the input: «Задачи 3/7» and the
 * task under way. A click opens the whole list upward. It is rewritten whole
 * on every update, so it lives here and not in the stream (spec 6.2), and it
 * pins nothing over the conversation.
 */
export function TodoStrip({ items, status }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const self = useRef<HTMLDivElement | null>(null)

  const done = items.filter((item) => item.status === 'completed').length
  const inTurn = status === 'busy' || status === 'waiting'
  const visible = items.length > 0 && (done < items.length || inTurn)

  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])

  // The list closes on a click anywhere else.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (!self.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  if (!visible) return null

  const current = items.find((item) => item.status === 'in_progress')
  const say = current ? current.activeForm || current.content : ''

  return (
    <div ref={self} className="todo-strip-wrap">
      <button
        type="button"
        className={`todo-strip${open ? ' is-open' : ''}`}
        data-testid="todo-strip"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ListChecks size={14} aria-hidden="true" />
        <span className="todo-count">
          Задачи {done}/{items.length}
        </span>
        {say && (
          <span className="todo-now" title={say}>
            {say}
          </span>
        )}
        <span className="todo-fill" />
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronUp size={13} aria-hidden="true" />}
      </button>

      {open && (
        <ul className="todo-list" data-testid="todo-list">
          {items.map((item, index) => (
            <li key={`${index}-${item.content}`} data-testid="todo-item" className={`todo-item is-${item.status}`}>
              <Mark status={item.status} />
              <span className="todo-text">{item.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
