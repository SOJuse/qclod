import { useEffect, useRef, useState } from 'react'
import type { CommandInfo } from '../../shared/types'
import { filterCommands } from '../../shared/commandFilter'
import './CommandPalette.css'

interface Props {
  commands: CommandInfo[]
  recent: string[]
  onPick: (command: CommandInfo) => void
  onClose: () => void
}

/**
 * The slash-command list, built from what the session actually offers.
 *
 * The first draft of the spec claimed commands could not be enumerated and
 * proposed five hard-coded buttons. The probe disproved it: `supportedCommands()`
 * returns everything — builtin, user and plugin — 130 of them on the user's
 * own machine (spec 6.7). So nothing here is hard-coded but the one entry that
 * cannot work, and that one says why.
 */
export function CommandPalette({ commands, recent, onPick, onClose }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const field = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLUListElement | null>(null)

  const matches = filterCommands(commands, query, recent)
  const active = Math.min(index, Math.max(0, matches.length - 1))

  useEffect(() => field.current?.focus(), [])
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function choose(command: CommandInfo | undefined): void {
    if (!command || command.unavailableReason) return
    onPick(command)
  }

  return (
    <div className="palette-backdrop" data-testid="command-palette" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={field}
          className="palette-query"
          data-testid="palette-query"
          placeholder="Команда…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((n) => (n + 1) % Math.max(1, matches.length))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((n) => (n - 1 + matches.length) % Math.max(1, matches.length))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(matches[active])
            }
          }}
        />

        {matches.length === 0 ? (
          <div className="palette-empty">Ничего не нашлось</div>
        ) : (
          <ul className="palette-list" ref={list}>
            {matches.map((command, at) => (
              <li
                key={command.name}
                data-testid="palette-item"
                className={`palette-item${at === active ? ' is-active' : ''}${
                  command.unavailableReason ? ' is-unavailable' : ''
                }`}
                title={command.unavailableReason ?? command.description}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(command)
                }}
              >
                <span className="palette-name">/{command.name}</span>
                {command.argumentHint && (
                  <span className="palette-hint">{command.argumentHint}</span>
                )}
                <span className="palette-description">
                  {command.unavailableReason ?? command.description}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
