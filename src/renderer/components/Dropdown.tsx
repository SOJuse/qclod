import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronUp } from 'lucide-react'
import { InlineMenu } from './InlineMenu'
import './Dropdown.css'

export interface DropdownOption {
  value: string
  /** The row in the list. */
  label: string
  /** The button's text when this is chosen, if the row's is too long for it. */
  short?: string
  /** A technical name beside the row, such as `low`. Monospace, faint. */
  hint?: string
  /** What choosing it means, in plain words. */
  secondary?: string
}

interface Props {
  testId: string
  /** What is being chosen — the control's accessible name. */
  label: string
  /** The chosen option; anything not among the options shows the placeholder. */
  value: string | null
  options: DropdownOption[]
  onChange: (value: string) => void
  /** The tooltip on the control. */
  title?: string
  /** Shown while nothing among the options is chosen. */
  placeholder?: string
  icon?: ReactNode
}

/**
 * A value that opens its list upward, the way the input's own lists open.
 *
 * The select-only combobox pattern: the control keeps the focus and points at
 * the highlighted row with `aria-activedescendant`. ↑↓ move, Enter or Space
 * pick, Esc closes without changing anything. A closed control leaves Esc
 * alone, so it still reaches whatever listens for it above.
 */
export function Dropdown({
  testId,
  label,
  value,
  options,
  onChange,
  title,
  placeholder = '—',
  icon
}: Props): JSX.Element {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(0)
  const disabled = options.length === 0
  const at = options.findIndex((o) => o.value === value)
  const current = at >= 0 ? options[at] : undefined

  const show = (): void => {
    setSelected(Math.max(0, at))
    setOpen(true)
  }
  const pick = (option: DropdownOption): void => {
    setOpen(false)
    if (option.value !== value) onChange(option.value)
  }

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    if (ev.key === 'Tab') {
      setOpen(false)
      return
    }
    if (!open) {
      if (!['ArrowUp', 'ArrowDown', 'Enter', ' '].includes(ev.key)) return
      ev.preventDefault()
      show()
      return
    }
    if (!['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Escape'].includes(ev.key)) return
    // An open list's keys are the list's alone: this Esc must not stop the agent.
    ev.preventDefault()
    ev.stopPropagation()
    if (ev.key === 'Escape') setOpen(false)
    else if (ev.key === 'Enter' || ev.key === ' ') pick(options[selected]!)
    else {
      const step = ev.key === 'ArrowDown' ? 1 : -1
      setSelected((row) => (row + step + options.length) % options.length)
    }
  }

  return (
    <span className="dropdown">
      <div
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        className={`dropdown-button${open ? ' is-open' : ''}`}
        data-testid={testId}
        data-value={current ? current.value : ''}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${selected}` : undefined}
        aria-disabled={disabled || undefined}
        title={title}
        onClick={() => {
          if (disabled) return
          if (open) setOpen(false)
          else show()
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        {icon}
        <span className="dropdown-value">
          {current ? (current.short ?? current.label) : placeholder}
        </span>
        <ChevronUp size={12} aria-hidden="true" className="dropdown-chevron" />
      </div>
      {open && (
        <InlineMenu
          id={listId}
          title={label}
          items={options.map((o) => ({
            id: o.value,
            primary: o.label,
            ...(o.hint ? { hint: o.hint } : {}),
            ...(o.secondary ? { secondary: o.secondary } : {})
          }))}
          selected={selected}
          onPick={(item) => {
            const option = options.find((o) => o.value === item.id)
            if (option) pick(option)
          }}
          testId={`${testId}-menu`}
          itemTestId={`${testId}-option`}
        />
      )}
    </span>
  )
}
