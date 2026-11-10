import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardCopy, Copy, ExternalLink, FolderOpen, SquarePen, type LucideIcon } from 'lucide-react'
import type { ResolvedPath, TabId } from '../../shared/types'
import { useAppStore } from '../state/useAppStore'
import { relativePath } from './linkify'
import { freshTarget } from './useResolvedPaths'

interface Item {
  label: string
  Icon: LucideIcon
  /** Returns a message to show instead of closing, or nothing. */
  run: () => Promise<string | null | void>
}

/** Keeps the menu inside the window: it opens at the pointer, or flips back. */
const EDGE = 8

/**
 * What can be done with one path, at the pointer. Arrows move, Enter picks,
 * Esc closes. «Открыть в редакторе» is there only when the settings name an
 * editor command.
 */
export function PathMenu({
  tabId,
  target,
  x,
  y,
  onClose
}: {
  tabId: TabId
  target: ResolvedPath
  x: number
  y: number
  /** `refocus`: give the focus back to the link (the keyboard was in use). */
  onClose: (refocus: boolean) => void
}): JSX.Element {
  const editorCommand = useAppStore((s) => s.settings?.editorCommand ?? '')
  const cwd = useAppStore((s) => s.tabs.find((t) => t.id === tabId)?.cwd ?? '')
  const box = useRef<HTMLDivElement | null>(null)
  const rows = useRef<Array<HTMLButtonElement | null>>([])
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState({ left: x, top: y })
  const [error, setError] = useState('')
  const close = useRef(onClose)
  close.current = onClose

  const act = (fn: (fresh: ResolvedPath) => Promise<unknown>) => async (): Promise<void> => {
    const fresh = await freshTarget(tabId, target)
    if (fresh) await fn(fresh)
  }

  const items: Item[] = [
    { label: 'Открыть', Icon: ExternalLink, run: act((p) => window.qclod.openPath(tabId, p.absPath)) },
    { label: 'Показать в проводнике', Icon: FolderOpen, run: act((p) => window.qclod.revealPath(tabId, p.absPath)) },
    { label: 'Скопировать путь', Icon: Copy, run: () => navigator.clipboard.writeText(target.absPath) },
    {
      label: 'Скопировать относительный путь',
      Icon: ClipboardCopy,
      run: () => navigator.clipboard.writeText(relativePath(cwd, target.absPath))
    }
  ]
  if (editorCommand.trim() !== '') {
    items.push({
      label: 'Открыть в редакторе',
      Icon: SquarePen,
      run: async () => {
        const fresh = await freshTarget(tabId, target)
        if (!fresh) return null
        return window.qclod.openInEditor(tabId, fresh.absPath, fresh.line, fresh.column)
      }
    })
  }

  // Measured once it is on screen: what does not fit right or below opens the other way.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = x + width + EDGE > window.innerWidth ? Math.max(EDGE, x - width) : x
    const top = y + height + EDGE > window.innerHeight ? Math.max(EDGE, y - height) : y
    setPlace({ left, top })
  }, [x, y, error])

  useEffect(() => {
    rows.current[active]?.focus({ preventScroll: true })
  }, [active])

  // A click elsewhere, the window losing focus or the page moving under it closes it.
  useEffect(() => {
    const outside = (e: Event): void => {
      if (!box.current?.contains(e.target as Node)) close.current(false)
    }
    const away = (): void => close.current(false)
    document.addEventListener('mousedown', outside, true)
    window.addEventListener('blur', away)
    window.addEventListener('resize', away)
    document.addEventListener('scroll', outside, true)
    return () => {
      document.removeEventListener('mousedown', outside, true)
      window.removeEventListener('blur', away)
      window.removeEventListener('resize', away)
      document.removeEventListener('scroll', outside, true)
    }
  }, [])

  const choose = (item: Item, byKeyboard: boolean): void => {
    void item
      .run()
      .then((message) => {
        if (typeof message === 'string' && message !== '') setError(message)
        else close.current(byKeyboard)
      })
      .catch(() => close.current(byKeyboard))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // The menu's keys are its own: nothing behind it reacts to them.
    e.stopPropagation()
    const last = items.length - 1
    if (e.key === 'ArrowDown') setActive((i) => (i >= last ? 0 : i + 1))
    else if (e.key === 'ArrowUp') setActive((i) => (i <= 0 ? last : i - 1))
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(last)
    else if (e.key === 'Escape' || e.key === 'Tab') onClose(true)
    // Enter and Space are the focused button's own: they click it.
    else return
    e.preventDefault()
  }

  return createPortal(
    <div
      ref={box}
      className="path-menu"
      data-testid="path-menu"
      role="menu"
      aria-label={target.absPath}
      style={{ left: place.left, top: place.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          ref={(el) => {
            rows.current[i] = el
          }}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          className={`path-menu-item${i === active ? ' is-active' : ''}`}
          data-testid="path-menu-item"
          onMouseEnter={() => setActive(i)}
          onClick={(e) => {
            e.stopPropagation()
            choose(item, e.detail === 0)
          }}
        >
          <item.Icon size={14} aria-hidden="true" />
          <span>{item.label}</span>
        </button>
      ))}
      {error && (
        <p className="path-menu-error" data-testid="path-menu-error" role="alert">
          {error}
        </p>
      )}
    </div>,
    document.body
  )
}
