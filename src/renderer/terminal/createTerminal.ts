import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { terminalTheme } from './theme'

export interface TerminalHandle {
  term: Terminal
  fit: () => { cols: number; rows: number }
  search: SearchAddon
  dispose: () => void
}

export function createTerminal(el: HTMLElement, fontSize: number): TerminalHandle {
  const term = new Terminal({
    fontFamily:
      "'Geist Mono', 'Cascadia Mono', 'Consolas', ui-monospace, monospace",
    fontSize,
    lineHeight: 1.25,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    // The terminal sits on the window's acrylic material, so it must not paint
    // its own opaque background.
    allowTransparency: true,
    theme: terminalTheme,
    scrollback: 20000,
    macOptionIsMeta: false,
    convertEol: false
  })

  const fitAddon = new FitAddon()
  const searchAddon = new SearchAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(searchAddon)
  term.open(el)

  const fit = (): { cols: number; rows: number } => {
    // A hidden tab's host is 0x0 and xterm would measure a degenerate size,
    // rewrapping its whole scrollback to ten columns and back on every switch.
    // Leave it exactly as it was until the element is on screen again.
    if (el.clientWidth <= 0 || el.clientHeight <= 0) {
      return { cols: term.cols, rows: term.rows }
    }
    try {
      fitAddon.fit()
    } catch {
      /* element not laid out yet */
    }
    return { cols: term.cols, rows: term.rows }
  }

  fit()

  return {
    term,
    fit,
    search: searchAddon,
    dispose: () => {
      searchAddon.dispose()
      fitAddon.dispose()
      term.dispose()
    }
  }
}
