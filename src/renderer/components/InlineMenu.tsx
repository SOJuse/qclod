import { useEffect, useId, useRef } from 'react'
import { Ban } from 'lucide-react'
import './InlineMenu.css'

export interface InlineMenuItem {
  id: string
  /** The thing itself: `/compact`, a file name, a model. Monospace. */
  primary: string
  /** What it is or where it lives, in plain words. */
  secondary?: string
  /** An argument the command expects, such as `<model>`. */
  hint?: string
  /** Set when it cannot be chosen here; shown in place of `secondary`. */
  disabledReason?: string
}

interface Props {
  items: InlineMenuItem[]
  selected: number
  onPick: (item: InlineMenuItem) => void
  testId: string
  itemTestId: string
  /** A line above the rows, for a list that needs saying what it is. */
  title?: string
}

/**
 * A list that opens upward from the field it belongs to — files after `@`,
 * commands after `/`. It never takes focus: the cursor stays in the input,
 * and the input's keys drive the selection.
 */
export function InlineMenu({
  items,
  selected,
  onPick,
  testId,
  itemTestId,
  title
}: Props): JSX.Element | null {
  const list = useRef<HTMLUListElement | null>(null)
  const baseId = useId()

  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected, items])

  if (items.length === 0) return null

  return (
    <div className="inline-menu" data-testid={testId}>
      {title && <div className="inline-menu-title">{title}</div>}
      <ul
        className="inline-menu-list"
        role="listbox"
        ref={list}
        aria-label={title}
        aria-activedescendant={`${baseId}-${selected}`}
      >
        {items.map((item, index) => {
          const disabled = Boolean(item.disabledReason)
          return (
            <li
              key={item.id}
              id={`${baseId}-${index}`}
              role="option"
              data-testid={itemTestId}
              aria-selected={index === selected}
              aria-disabled={disabled || undefined}
              className={`inline-menu-item${index === selected ? ' is-selected' : ''}${
                disabled ? ' is-disabled' : ''
              }`}
              title={item.disabledReason ?? item.secondary}
              onMouseDown={(ev) => {
                // The field keeps focus; a click is a pick, not a blur.
                ev.preventDefault()
                if (!disabled) onPick(item)
              }}
            >
              <span className="inline-menu-primary">{item.primary}</span>
              {item.hint && <span className="inline-menu-hint">{item.hint}</span>}
              {disabled ? (
                <span className="inline-menu-secondary">
                  <Ban size={12} aria-hidden="true" className="inline-menu-ban" />
                  {item.disabledReason}
                </span>
              ) : (
                item.secondary && <span className="inline-menu-secondary">{item.secondary}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
