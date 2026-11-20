import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { paletteState, searchPalette, sectionTitle } from '../palette/providers'
import type { PaletteContext, PaletteItem, PaletteSection } from '../palette/types'
import { useModalFocus } from '../ui/modalFocus'
import { StateView, reasonOf } from '../ui/StateView'
import './CommandPalette.css'

interface Props {
  ctx: PaletteContext
  /** Opened for one section alone (Ctrl+H: the past ones); a chip above the field says which. */
  initialScope?: PaletteSection
  onClose: () => void
  /** Closing gives focus back to the opener; this runs when the opener is gone. */
  onFocusLost?: () => void
}

const optionId = (index: number): string => `palette-option-${index}`

/**
 * Ctrl+K: one field over everything — open chats, projects, past
 * conversations, the active chat's files and the commands — in sections,
 * a heading over each. Enter does what the chosen row says.
 */
export function CommandPalette({ ctx, initialScope, onClose, onFocusLost }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<PaletteSection | undefined>(initialScope)
  /** The chosen row by its key: rows that arrive later (a history read) do not move the choice. */
  const [chosenKey, setChosenKey] = useState<string | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLUListElement | null>(null)
  const sheet = useRef<HTMLDivElement | null>(null)
  const trap = useModalFocus(sheet, onFocusLost)

  useEffect(() => field.current?.focus(), [])

  const shown = useMemo(() => searchPalette(query, ctx, scope), [query, ctx, scope])
  // A section shown alone with nothing yet says why: still read, or failed — not «nothing found».
  const pending = shown.length === 0 ? paletteState(query, ctx, scope) : null
  const selected = Math.max(0, shown.findIndex((item) => item.key === chosenKey))

  useEffect(() => {
    list.current?.querySelector(`#${optionId(selected)}`)?.scrollIntoView({ block: 'nearest' })
  }, [selected, shown])

  const run = (item: PaletteItem | undefined): void => {
    if (!item) return
    onClose()
    item.run()
  }
  const move = (delta: number): void => {
    if (shown.length === 0) return
    setChosenKey(shown[(selected + delta + shown.length) % shown.length]!.key)
  }

  return (
    <div className="sheet-backdrop action-palette-backdrop" onMouseDown={onClose}>
      <div
        ref={sheet}
        className="sheet action-palette ring-host"
        data-testid="action-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Поиск"
        onKeyDown={trap}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-field">
          {scope !== undefined && (
            <span className="palette-scope" data-testid="palette-scope" data-section={scope}>
              {sectionTitle(scope)}
            </span>
          )}
          <input
            ref={field}
            className="action-palette-query ring-on-parent"
            data-testid="action-query"
            placeholder="Чат, проект, файл или команда"
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="action-palette-list"
            aria-activedescendant={shown.length > 0 ? optionId(selected) : undefined}
            onChange={(e) => {
              setQuery(e.target.value)
              setChosenKey(null)
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(shown[selected])
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                move(1)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                move(-1)
              } else if (e.key === 'Backspace' && query === '' && scope !== undefined) {
                // Backspace in the empty field takes the chip off: the search is over everything again.
                e.preventDefault()
                setScope(undefined)
                setChosenKey(null)
              }
            }}
          />
        </div>
        {pending?.kind === 'loading' ? (
          <StateView kind="loading" title="Загружаю…" />
        ) : pending?.kind === 'error' ? (
          <StateView
            kind="error"
            title={pending.title}
            hint={reasonOf(pending.reason)}
            action={{
              label: 'Повторить',
              onClick: () => {
                pending.retry()
                field.current?.focus()
              }
            }}
          />
        ) : shown.length === 0 ? (
          <StateView kind="empty" title="Ничего не нашлось" />
        ) : (
          <ul className="sheet-body action-palette-list" id="action-palette-list" role="listbox" ref={list}>
            {shown.map((item, index) => (
              <Fragment key={item.key}>
                {/* Kept to one section, the chip already names it. */}
                {scope === undefined && item.section !== shown[index - 1]?.section && (
                  <li className="palette-section" data-testid="palette-section" role="presentation">
                    {sectionTitle(item.section)}
                  </li>
                )}
                <li
                  id={optionId(index)}
                  role="option"
                  data-testid="action-item"
                  data-section={item.section}
                  aria-selected={index === selected}
                  className={`action-palette-item${index === selected ? ' is-selected' : ''}`}
                  title={item.hint ? `${item.title} — ${item.hint}` : item.title}
                  onMouseMove={() => index !== selected && setChosenKey(item.key)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    run(item)
                  }}
                >
                  <span className="action-palette-label">{item.title}</span>
                  {item.hint && <span className="action-palette-hint">{item.hint}</span>}
                  {item.keys && <span className="action-palette-keys">{item.keys}</span>}
                </li>
              </Fragment>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
