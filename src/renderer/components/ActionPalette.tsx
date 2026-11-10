import { useEffect, useMemo, useRef, useState } from 'react'
import { score } from '../../shared/commandFilter'
import { APP_ACTIONS, type AppActionId } from '../app/shortcuts'
import './ActionPalette.css'

interface Props {
  onRun: (id: AppActionId) => void
  onClose: () => void
}

/**
 * Ctrl+K: the window's own actions in a small list at the top, found by a few
 * letters of their name. Not the slash list — that one is for the agent.
 */
export function ActionPalette({ onRun, onClose }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const field = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLUListElement | null>(null)

  useEffect(() => field.current?.focus(), [])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return APP_ACTIONS
    return APP_ACTIONS.map((action, order) => ({
      action,
      order,
      points: score(action.label.toLowerCase(), needle)
    }))
      .filter((entry) => entry.points !== null)
      .sort((a, b) => b.points! - a.points! || a.order - b.order)
      .map((entry) => entry.action)
  }, [query])

  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected, shown])

  const run = (index: number): void => {
    const action = shown[index]
    if (action) onRun(action.id)
  }

  return (
    <div className="action-palette-backdrop" onMouseDown={onClose}>
      <div
        className="action-palette"
        data-testid="action-palette"
        role="dialog"
        aria-label="Палитра действий"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={field}
          className="action-palette-query"
          data-testid="action-query"
          placeholder="Что сделать?"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="action-palette-list"
          aria-activedescendant={shown[selected] ? `action-${shown[selected]!.id}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(selected)
            } else if (e.key === 'ArrowDown' && shown.length > 0) {
              e.preventDefault()
              setSelected((selected + 1) % shown.length)
            } else if (e.key === 'ArrowUp' && shown.length > 0) {
              e.preventDefault()
              setSelected((selected - 1 + shown.length) % shown.length)
            }
          }}
        />
        {shown.length === 0 ? (
          <div className="action-palette-empty">Такого действия нет</div>
        ) : (
          <ul className="action-palette-list" id="action-palette-list" role="listbox" ref={list}>
            {shown.map((action, index) => (
              <li
                key={action.id}
                id={`action-${action.id}`}
                role="option"
                data-testid="action-item"
                aria-selected={index === selected}
                className={`action-palette-item${index === selected ? ' is-selected' : ''}`}
                onMouseMove={() => selected !== index && setSelected(index)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  run(index)
                }}
              >
                <span className="action-palette-label">{action.label}</span>
                {action.keys && <span className="action-palette-keys">{action.keys}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
