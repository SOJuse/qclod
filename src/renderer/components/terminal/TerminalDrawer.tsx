import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TabId } from '../../../shared/types'
import { physicalKey } from '../../input/physicalKey'
import { useAppStore } from '../../state/useAppStore'
import { reasonOf } from '../../ui/StateView'
import './TerminalDrawer.css'

export const TERMINAL_TEXTS = {
  title: (label: string) => `Терминал — ${label}`,
  ended: 'Сессия завершена. Enter — открыть снова',
  failed: 'Терминал не открылся.',
  failedWhy: (reason: string) => `Терминал не открылся: ${reason.replace(/\.$/, '')}.`,
  hide: 'Скрыть'
} as const

/** The drawer's share of the pane, by default and at the ends of a drag. */
const MIN_SHARE = 0.15
const MAX_SHARE = 0.85

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

type KeyLike = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

/**
 * Whose a key pressed in the terminal is (R10). The window keeps the keys
 * that move between chats and open the settings — Ctrl+Tab, Ctrl+Shift+Tab,
 * Ctrl+1…9, Ctrl+, — so the terminal is no trap; Ctrl+Shift+K opens the
 * palette. Everything else, Ctrl+K (bash's kill-line), Ctrl+W, Ctrl+R and
 * Ctrl+C among them, is the shell's.
 */
export function terminalKeyRoute(ev: KeyLike): 'terminal' | 'window' | 'palette' {
  if (!ev.ctrlKey || ev.altKey || ev.metaKey) return 'terminal'
  if (ev.code === 'Tab') return 'window'
  const k = physicalKey(ev)
  if (ev.shiftKey) return k === 'k' ? 'palette' : 'terminal'
  if (ev.code === 'Comma' || /^[1-9]$/.test(k)) return 'window'
  return 'terminal'
}

/**
 * A server chat's terminal (stage 6, task 26): xterm.js in a drawer under the
 * chat, ssh -tt in node-pty on main's side. Hidden, it stays mounted and its
 * session lives on. Unmounted — the chat left the panes — the session lives on
 * too (R1): its id stays in the store, and the drawer that comes back takes it
 * up with what it printed meanwhile. Only closing the chat closes it (main's
 * TerminalHub.closeTab), or the shell's own exit.
 */
export function TerminalDrawer({
  tabId,
  label,
  shown,
  onHide,
  onOpenPalette
}: {
  tabId: TabId
  label: string
  shown: boolean
  onHide(): void
  /** Ctrl+Shift+K in the terminal: the palette (Ctrl+K there is the shell's). */
  onOpenPalette?: () => void
}): JSX.Element {
  const self = useRef<HTMLDivElement | null>(null)
  const host = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const paletteRef = useRef(onOpenPalette)
  paletteRef.current = onOpenPalette
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
    termRef.current = term
    // false: xterm leaves the key alone and it goes on to the window's shortcuts.
    term.attachCustomKeyEventHandler((ev) => {
      const route = terminalKeyRoute(ev)
      if (route === 'terminal') return true
      if (route === 'palette' && ev.type === 'keydown') {
        ev.preventDefault()
        paletteRef.current?.()
      }
      return false
    })
    try {
      fit.fit()
    } catch {
      // Not laid out yet: the observer below fits it.
    }

    let termId: string | null = null
    let gone = false
    let over = false
    const store = useAppStore.getState
    const finish = (text: string): void => {
      over = true
      setEnded(true)
      term.writeln(`\r\n${text}`)
    }
    const start = (): void => {
      over = false
      setEnded(false)
      window.qclod.terminalOpen(tabId, Math.max(2, term.cols), Math.max(2, term.rows)).then(
        (id) => {
          // Kept even when the drawer went meanwhile: the next one takes it up.
          if (id && store().tabs.some((t) => t.id === tabId)) store().setTerminalId(tabId, id)
          if (gone) return
          termId = id
          if (!id) finish(`${TERMINAL_TEXTS.failed} ${TERMINAL_TEXTS.ended}`)
        },
        (err: unknown) => {
          if (!gone) finish(`${TERMINAL_TEXTS.failedWhy(reasonOf(err))} ${TERMINAL_TEXTS.ended}`)
        }
      )
    }
    /**
     * The session this tab's drawer had before. Output that comes as events
     * before the answer is in the backlog already, so it is not written twice:
     * termId is set only once the backlog is.
     */
    const resume = (id: string): void => {
      window.qclod.terminalAttach(tabId, id).then(
        (backlog) => {
          if (gone) return
          if (backlog === null) {
            // It ended while the chat was not on screen: said so, and Enter opens a new one.
            store().setTerminalId(tabId, null)
            finish(TERMINAL_TEXTS.ended)
            return
          }
          term.write(backlog)
          termId = id
          void window.qclod.terminalResize(id, Math.max(2, term.cols), Math.max(2, term.rows)).catch(() => undefined)
        },
        () => {
          if (!gone) start()
        }
      )
    }
    const offData = window.qclod.onTerminalData((e) => {
      if (e.termId === termId) term.write(e.data)
    })
    const offExit = window.qclod.onTerminalExit((e) => {
      if (e.termId !== termId) return
      termId = null
      store().setTerminalId(tabId, null)
      finish(TERMINAL_TEXTS.ended)
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
    const before = store().terminalIdByTab[tabId]
    if (before) resume(before)
    else start()
    return () => {
      // The session is not closed here (R1): the chat only left the panes.
      gone = true
      termRef.current = null
      observer.disconnect()
      input.dispose()
      resize.dispose()
      offData()
      offExit()
      term.dispose()
    }
  }, [tabId])

  // Shown, the keys go to the terminal at once (R10).
  useEffect(() => {
    if (shown) termRef.current?.focus()
  }, [shown, tabId])

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
