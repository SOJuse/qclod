import { useRef, useState, type ReactNode } from 'react'
import type { ResolvedPath, TabId } from '../../shared/types'
import { linkify } from './linkify'
import { PathMenu } from './PathMenu'
import { freshTarget } from './useResolvedPaths'
import './Paths.css'

/**
 * A path in the text that exists on disk. It reads as the text around it; a
 * click opens it with its program (a folder in Explorer, anything that could
 * run is only shown there — main decides). Right click or Shift+F10 opens
 * the menu.
 */
export function PathLink({
  tabId,
  target,
  children
}: {
  tabId: TabId
  target: ResolvedPath
  children: ReactNode
}): JSX.Element {
  const self = useRef<HTMLAnchorElement | null>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

  const open = (): void => {
    void freshTarget(tabId, target).then((fresh) => {
      if (fresh) void window.qclod.openPath(tabId, fresh.absPath)
    })
  }

  // From the keyboard there is no pointer: the menu sits under the link.
  const menuUnderLink = (): void => {
    const box = self.current?.getBoundingClientRect()
    if (box) setMenuAt({ x: box.left, y: box.bottom })
  }

  return (
    <>
      <a
        ref={self}
        className="path-link"
        data-testid="path-link"
        role="link"
        tabIndex={0}
        title={target.absPath}
        onClick={(e) => {
          // Inside a card's head the click must not fold or unfold the card.
          e.preventDefault()
          e.stopPropagation()
          open()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            open()
          } else if (e.key === 'F10' && e.shiftKey) {
            e.preventDefault()
            e.stopPropagation()
            menuUnderLink()
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          // The Menu key fires this too, with no pointer position.
          if (e.clientX === 0 && e.clientY === 0) menuUnderLink()
          else setMenuAt({ x: e.clientX, y: e.clientY })
        }}
      >
        {children}
      </a>
      {menuAt && (
        <PathMenu
          tabId={tabId}
          target={target}
          x={menuAt.x}
          y={menuAt.y}
          onClose={(refocus) => {
            setMenuAt(null)
            if (refocus) self.current?.focus()
          }}
        />
      )}
    </>
  )
}

/** Text with its known paths turned into links. */
export function LinkedText({
  tabId,
  text,
  resolved,
  code = false
}: {
  tabId: TabId
  text: string
  resolved: ReadonlyMap<string, ResolvedPath>
  code?: boolean
}): JSX.Element {
  return (
    <>
      {linkify(text, resolved, code).map((piece, i) =>
        typeof piece === 'string' ? (
          piece
        ) : (
          <PathLink key={i} tabId={tabId} target={piece.target}>
            {piece.text}
          </PathLink>
        )
      )}
    </>
  )
}
