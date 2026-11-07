import { useEffect, useRef } from 'react'
import { createTerminal, type TerminalHandle } from '../terminal/createTerminal'
import { resolveTerminalKey } from '../terminal/keymap'
import { encodeForPty } from '../input/encode'
import type { TabId } from '../../shared/types'
import './TerminalView.css'

interface Props {
  tabId: TabId
  fontSize: number
  focused: boolean
  onRequestFocus: () => void
  onToggleFocus: () => void
  onFontSize: (next: number) => void
}

export function TerminalView({
  tabId,
  fontSize,
  focused,
  onRequestFocus,
  onToggleFocus,
  onFontSize
}: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<TerminalHandle | null>(null)
  // Keep the latest callbacks reachable from the terminal's own listeners,
  // which are attached once for the terminal's lifetime.
  const actions = useRef({ onToggleFocus, onFontSize, fontSize })
  actions.current = { onToggleFocus, onFontSize, fontSize }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const handle = createTerminal(host, fontSize)
    handleRef.current = handle

    const offData = window.qclod.onSessionData((event) => {
      if (event.tabId === tabId) handle.term.write(event.chunk)
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
      offData()
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
      className={`terminal-surface${focused ? ' is-focused' : ''}`}
      data-testid="terminal"
      onMouseDown={onRequestFocus}
    >
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
}

