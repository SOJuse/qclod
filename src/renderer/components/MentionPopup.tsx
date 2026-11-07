import { useEffect, useRef } from 'react'
import './MentionPopup.css'

interface Props {
  items: string[]
  selected: number
  onPick: (path: string) => void
}

export function MentionPopup({ items, selected, onPick }: Props): JSX.Element | null {
  const listRef = useRef<HTMLUListElement | null>(null)

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (items.length === 0) return null

  return (
    <ul className="mention-popup" data-testid="mention-popup" ref={listRef}>
      {items.map((path, index) => {
        const slash = path.lastIndexOf('/')
        return (
          <li
            key={path}
            data-testid="mention-item"
            className={`mention-item${index === selected ? ' is-selected' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(path)
            }}
          >
            <span className="mention-name">{path.slice(slash + 1)}</span>
            {slash > 0 && <span className="mention-dir">{path.slice(0, slash)}</span>}
          </li>
        )
      })}
    </ul>
  )
}
