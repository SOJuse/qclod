import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronUp } from 'lucide-react'
import { InlineMenu } from './InlineMenu'

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
  /** What is being chosen — the button's accessible name. */
  label: string
  value: string | null
  options: DropdownOption[]
  onChange: (value: string) => void
  /** The tooltip on the button. */
  title?: string
  /** Shown while nothing is chosen. */
  placeholder?: string
  icon?: ReactNode
}

/**
 * A button that shows a value and opens its list upward, the way the input's
 * own lists open. The button keeps the focus, so the keys work as they do
 * there: ↑↓ move, Enter picks, Esc closes without changing anything.
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
  const current = options.find((o) => o.value === value)

  const show = (): void => {
    setSelected(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }
  const pick = (option: DropdownOption): void => {
    setOpen(false)
    if (option.value !== value) onChange(option.value)
  }

  const onKeyDown = (ev: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    const keys = ['ArrowUp', 'ArrowDown', 'Enter', 'Escape']
    if (!keys.includes(ev.key)) {
      if (ev.key === 'Tab') setOpen(false)
      return
    }
    // The list's keys are the list's alone: Esc here must not stop the agent.
    ev.preventDefault()
    ev.stopPropagation()
    if (!open) {
      if (ev.key !== 'Escape') show()
      return
    }
    if (ev.key === 'Escape') setOpen(false)
    else if (ev.key === 'Enter') pick(options[selected]!)
    else {
      const step = ev.key === 'ArrowDown' ? 1 : -1
      setSelected((at) => (at + step + options.length) % options.length)
    }
  }

  return (
    <span className="dropdown">
      <button
        type="button"
        className={`dropdown-button${open ? ' is-open' : ''}`}
        data-testid={testId}
        data-value={value ?? ''}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${selected}` : undefined}
        title={title}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        {icon}
        <span className="dropdown-value">
          {current ? (current.short ?? current.label) : (value ?? placeholder)}
        </span>
        <ChevronUp size={12} aria-hidden="true" className="dropdown-chevron" />
      </button>
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
