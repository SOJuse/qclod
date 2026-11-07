/** Smallest size we are willing to tell an agent its terminal is. */
export const MIN_COLS = 20
export const MIN_ROWS = 5

export interface Size {
  cols: number
  rows: number
}

export interface HostBox {
  width: number
  height: number
}

/**
 * Decides what size — if any — the pty should be told about.
 *
 * A tab that is hidden with `display: none` has a 0x0 host, and xterm then
 * measures a degenerate size (10x5 in practice). Forwarding that makes the
 * agent reflow its entire full-screen interface to ten columns, rewrapping the
 * whole conversation; switching back rewraps it again. On a long session that
 * is the difference between an instant tab switch and a ten-to-twenty-second
 * freeze.
 *
 * So: only report a size the element actually has, and only when it changed.
 * A hidden tab keeps whatever size it had while it was visible.
 */
export function nextPtySize(host: HostBox, measured: Size, current: Size | null): Size | null {
  if (host.width <= 0 || host.height <= 0) return null
  if (measured.cols < MIN_COLS || measured.rows < MIN_ROWS) return null
  if (current && current.cols === measured.cols && current.rows === measured.rows) return null
  return { cols: measured.cols, rows: measured.rows }
}
