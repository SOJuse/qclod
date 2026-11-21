import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TabId } from '../../../shared/types'
import './TerminalDrawer.css'

export const TERMINAL_TEXTS = {
  title: (label: string) => `Терминал — ${label}`,
  ended: 'Сессия завершена. Enter — открыть снова',
  failed: 'Терминал не открылся.',
  hide: 'Скрыть'
} as const

/** The drawer's share of the pane, by default and at the ends of a drag. */
const MIN_SHARE = 0.15
const MAX_SHARE = 0.85

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * A server chat's terminal (stage 6, task 26): xterm.js in a drawer under the
 * chat, ssh -tt in node-pty on main's side. Hidden, it stays mounted and its
 * session lives on; closing the chat closes it (main's TerminalHub.closeTab).
 */
export function TerminalDrawer({
  tabId,
  label,
  shown,
  onHide
}: {
  tabId: TabId
  label: string
  shown: boolean
  onHide(): void
}): JSX.Element {
  const self = useRef<HTMLDivElement | null>(null)
  const host = useRef<HTMLDivElement | null>(null)
  const [ended, setEnded] = useState(false)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: 13,
      cursorBlink: true,
      // The DOM renderer: no canvas or WebGL to fall over in a locked-down window.
      theme: {
        background: cssVar('--surface', ''),
        foreground: cssVar('--text', ''),
        cursor: cssVar('--accent', '')
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      fit.fit()
    } catch {
      // Not laid out yet: the observer below fits it.
    }

    let termId: string | null = null
    let gone = false
    let over = false
    const start = (): void => {
      over = false
      setEnded(false)
      void window.qclod
        .terminalOpen(tabId, Math.max(2, term.cols), Math.max(2, term.rows))
        .then((id) => {
          if (gone) {
            if (id) void window.qclod.terminalClose(id)
            return
          }
          termId = id
          if (!id) {
            over = true
            setEnded(true)
            term.writeln(`\r\n${TERMINAL_TEXTS.failed} ${TERMINAL_TEXTS.ended}`)
          }
        })
    }
    const offData = window.qclod.onTerminalData((e) => {
      if (e.termId === termId) term.write(e.data)
    })
    const offExit = window.qclod.onTerminalExit((e) => {
      if (e.termId !== termId) return
      termId = null
      over = true
      setEnded(true)
      term.writeln(`\r\n${TERMINAL_TEXTS.ended}`)
    })
    const input = term.onData((data) => {
      if (over) {
        if (data === '\r') start()
        return
      }
      if (termId) window.qclod.terminalInput(termId, data)
    })
    const resize = term.onResize(({ cols, rows }) => {
      if (termId) void window.qclod.terminalResize(termId, cols, rows)
    })
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // Hidden: nothing to fit to.
      }
    })
    observer.observe(el)
    start()
    return () => {
      gone = true
      observer.disconnect()
      input.dispose()
      resize.dispose()
      offData()
      offExit()
      if (termId) void window.qclod.terminalClose(termId)
      term.dispose()
    }
  }, [tabId])

  // The height follows the handle; kept as a share of the pane.
  const drag = (ev: React.PointerEvent<HTMLDivElement>): void => {
    const drawer = self.current
    const pane = drawer?.parentElement
    if (!drawer || !pane) return
    ev.preventDefault()
    const box = pane.getBoundingClientRect()
    const move = (e: PointerEvent): void => {
      const share = Math.min(MAX_SHARE, Math.max(MIN_SHARE, (box.bottom - e.clientY) / box.height))
      drawer.style.setProperty('--terminal-share', String(share))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      ref={self}
      className={`terminal-drawer${shown ? '' : ' is-hidden'}`}
      data-testid="terminal-drawer"
      data-ended={ended ? 'true' : 'false'}
    >
      <div className="terminal-handle" role="separator" aria-orientation="horizontal" onPointerDown={drag} />
      <header className="terminal-head">
        <span className="terminal-title">{TERMINAL_TEXTS.title(label)}</span>
        <button type="button" className="terminal-hide" data-testid="terminal-hide" title={TERMINAL_TEXTS.hide} onClick={onHide}>
          <ChevronDown size={14} aria-hidden="true" />
          <span>{TERMINAL_TEXTS.hide}</span>
        </button>
      </header>
      <div className="terminal-host" ref={host} />
    </div>
  )
}
