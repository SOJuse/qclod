import { useEffect, useRef } from 'react'
import { createTerminal, type TerminalHandle } from '../terminal/createTerminal'
import { resolveTerminalKey } from '../terminal/keymap'
import { encodeForPty } from '../input/encode'
import { detectMenu } from '../terminal/menuDetect'
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
  onMenuActive: (active: boolean) => void
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
  const handleRef = useRef<TerminalHandle | null>(null)
  // Keep the latest callbacks reachable from the terminal's own listeners,
  // which are attached once for the terminal's lifetime.
  const actions = useRef({ onToggleFocus, onFontSize, fontSize, onMenuActive })
  actions.current = { onToggleFocus, onFontSize, fontSize, onMenuActive }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const handle = createTerminal(host, fontSize)
    handleRef.current = handle

    // Menu detection runs on a short debounce: a redraw arrives in several
    // chunks and checking mid-redraw would read a half-painted screen.
    let menuTimer: ReturnType<typeof setTimeout> | undefined
    let lastMenu = false
    const checkMenu = (): void => {
      const buffer = handle.term.buffer.active
      const lines: string[] = []
      for (let row = 0; row < handle.term.rows; row++) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
      }
      const active = detectMenu(lines)
      if (active !== lastMenu) {
        lastMenu = active
        actions.current.onMenuActive(active)
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
            // encodeForPty strips paste markers and control characters, so
            // clipboard content cannot break out of the paste block.
            if (text) void window.qclod.write(tabId, encodeForPty(text))
          })
          return false
        case 'selectAll':
          handle.term.selectAll()
          return false
        case 'search':
          // Search UI lands with the title bar; Ctrl+F must not reach the agent.
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

    // Selecting with the mouse copies on release, the way a terminal should.
    handle.term.onSelectionChange(() => {
      const selection = handle.term.getSelection()
      if (selection) void navigator.clipboard.writeText(selection)
    })

    const syncSize = (): void => {
      const { cols, rows } = handle.fit()
      void window.qclod.resize(tabId, cols, rows)
    }
    syncSize()

    const observer = new ResizeObserver(syncSize)
    observer.observe(host)

    return () => {
      observer.disconnect()
      clearTimeout(menuTimer)
      offData()
      // Do not leave a stale "menu is open" belief behind for this tab.
      if (lastMenu) actions.current.onMenuActive(false)
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
    const { cols, rows } = handle.fit()
    void window.qclod.resize(tabId, cols, rows)
  }, [fontSize, tabId])

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
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
}

