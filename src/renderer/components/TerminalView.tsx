import { useEffect, useRef, useState } from 'react'
import { createTerminal, type TerminalHandle } from '../terminal/createTerminal'
import { resolveTerminalKey } from '../terminal/keymap'
import { chunkForPty } from '../input/encode'
import { detectMenu, detectMenuLikely } from '../terminal/menuDetect'
import { SelectionCopyGate } from '../terminal/selectionCopy'
import { nextPtySize, type Size } from '../terminal/ptySize'
import type { TabId } from '../../shared/types'
import './TerminalView.css'

interface Props {
  tabId: TabId
  hidden?: boolean
  fontSize: number
  focused: boolean
  onRequestFocus: () => void
  onToggleFocus: () => void
  onFontSize: (next: number) => void
  onMenuActive: (signals: { focusWorthy: boolean; likely: boolean }) => void
}

export function TerminalView({
  tabId,
  hidden = false,
  fontSize,
  focused,
  onRequestFocus,
  onToggleFocus,
  onFontSize,
  onMenuActive
}: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const handleRef = useRef<TerminalHandle | null>(null)
  const lastSize = useRef<Size | null>(null)
  // Keep the latest callbacks reachable from the terminal's own listeners,
  // which are attached once for the terminal's lifetime.
  const actions = useRef({ onToggleFocus, onFontSize, fontSize, onMenuActive, openSearch: () => setSearchOpen(true) })
  actions.current = {
    ...actions.current,
    onToggleFocus,
    onFontSize,
    fontSize,
    onMenuActive
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const handle = createTerminal(host, fontSize)
    handleRef.current = handle

    // Menu detection runs on a short debounce: a redraw arrives in several
    // chunks and checking mid-redraw would read a half-painted screen.
    let menuTimer: ReturnType<typeof setTimeout> | undefined
    let lastMenu = { focusWorthy: false, likely: false }
    const checkMenu = (): void => {
      const buffer = handle.term.buffer.active
      const lines: string[] = []
      for (let row = 0; row < handle.term.rows; row++) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
      }
      const next = { focusWorthy: detectMenu(lines), likely: detectMenuLikely(lines) }
      if (next.focusWorthy !== lastMenu.focusWorthy || next.likely !== lastMenu.likely) {
        lastMenu = next
        actions.current.onMenuActive(next)
      }
    }

    const offData = window.qclod.onSessionData((event) => {
      if (event.tabId !== tabId) return
      handle.term.write(event.chunk, () => {
        clearTimeout(menuTimer)
        menuTimer = setTimeout(checkMenu, 80)
      })
    })

    handle.term.onData((data) => {
      void window.qclod.write(tabId, data)
    })

    const copyGate = new SelectionCopyGate()

    handle.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      const action = resolveTerminalKey(ev, { hasSelection: handle.term.hasSelection() })

      switch (action) {
        case 'toPty':
          return true
        case 'copy': {
          const selection = handle.term.getSelection()
          if (selection) void navigator.clipboard.writeText(selection)
          return false
        }
        case 'paste':
          void navigator.clipboard.readText().then((text) => {
            // Chunked like the composer: a multi-megabyte clipboard must not
            // arrive as one IPC message and one pty write.
            for (const chunk of chunkForPty(text)) void window.qclod.write(tabId, chunk)
          })
          return false
        case 'selectAll':
          copyGate.programmaticSelect()
          handle.term.selectAll()
          return false
        case 'search':
          actions.current.openSearch()
          return false
        case 'clear':
          handle.term.clear()
          return false
        case 'fontUp':
          actions.current.onFontSize(Math.min(28, actions.current.fontSize + 1))
          return false
        case 'fontDown':
          actions.current.onFontSize(Math.max(9, actions.current.fontSize - 1))
          return false
        case 'fontReset':
          actions.current.onFontSize(13)
          return false
        case 'toggleFocus':
          actions.current.onToggleFocus()
          return false
      }
    })

    // Selecting with the mouse copies on release, the way a terminal should —
    // and Ctrl+A selects without touching the clipboard.
    const copySelection = (): void => {
      const selection = handle.term.getSelection()
      if (selection) void navigator.clipboard.writeText(selection)
    }
    handle.term.onSelectionChange(() => {
      if (copyGate.selectionChanged()) copySelection()
    })
    host.addEventListener('mousedown', (ev) => {
      if (ev.button === 1) {
        // Middle-click pastes, the way a terminal does (spec 6.5).
        ev.preventDefault()
        void navigator.clipboard.readText().then((text) => {
          for (const chunk of chunkForPty(text)) void window.qclod.write(tabId, chunk)
        })
        return
      }
      copyGate.pointerDown()
    })
    const onMouseUp = (): void => {
      if (copyGate.pointerUp()) copySelection()
    }
    window.addEventListener('mouseup', onMouseUp)

    const syncSize = (): void => {
      const measured = handle.fit()
      const next = nextPtySize(
        { width: host.clientWidth, height: host.clientHeight },
        measured,
        lastSize.current
      )
      if (!next) return
      lastSize.current = next
      void window.qclod.resize(tabId, next.cols, next.rows)
    }
    syncSize()

    const observer = new ResizeObserver(syncSize)
    observer.observe(host)

    return () => {
      observer.disconnect()
      window.removeEventListener('mouseup', onMouseUp)
      clearTimeout(menuTimer)
      offData()
      // Do not leave a stale "menu is open" belief behind for this tab.
      if (lastMenu.focusWorthy || lastMenu.likely) {
        actions.current.onMenuActive({ focusWorthy: false, likely: false })
      }
      handle.dispose()
      handleRef.current = null
    }
    // The terminal instance is created once per tab; font size is applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    handle.term.options.fontSize = fontSize
    const host = hostRef.current
    if (!host) return
    const next = nextPtySize(
      { width: host.clientWidth, height: host.clientHeight },
      handle.fit(),
      lastSize.current
    )
    if (!next) return
    lastSize.current = next
    void window.qclod.resize(tabId, next.cols, next.rows)
  }, [fontSize, tabId])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    if (focused) handleRef.current?.term.focus()
    else handleRef.current?.term.blur()
  }, [focused])

  return (
    <div
      className={`terminal-surface${focused ? ' is-focused' : ''}${hidden ? ' is-hidden' : ''}`}
      data-testid="terminal"
      onMouseDown={onRequestFocus}
    >
      {searchOpen && (
        <div className="terminal-search" data-testid="terminal-search">
          <input
            ref={searchInputRef}
            data-testid="terminal-search-input"
            placeholder="поиск по выводу…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              handleRef.current?.search.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                handleRef.current?.search.clearDecorations()
                setSearchOpen(false)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) handleRef.current?.search.findPrevious(query)
                else handleRef.current?.search.findNext(query)
              }
            }}
          />
          <button
            type="button"
            data-testid="terminal-search-close"
            aria-label="Закрыть поиск"
            onClick={() => {
              handleRef.current?.search.clearDecorations()
              setSearchOpen(false)
            }}
          >
            ×
          </button>
        </div>
      )}
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
}

