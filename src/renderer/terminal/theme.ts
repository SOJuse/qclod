import type { ITheme } from '@xterm/xterm'

/**
 * The CLI paints its own prompt with truecolor SGR, not palette indices
 * (probe note 3), so the "dim echo / bright composer" hierarchy from spec 6.4
 * cannot be done by remapping slots. It is done in CSS instead — see
 * `.terminal-surface` in terminal.css. This theme only has to sit well on the
 * acrylic background and stay readable.
 */
export const terminalTheme: ITheme = {
  background: 'rgba(0,0,0,0)',
  foreground: '#e6e8f2',
  cursor: '#6e8bff',
  cursorAccent: '#0e101c',
  selectionBackground: 'rgba(110,139,255,0.32)',

  black: '#0e101c',
  red: '#ff7a7a',
  green: '#67d8a0',
  yellow: '#ffc46b',
  blue: '#6e8bff',
  magenta: '#b07cff',
  cyan: '#68d8e3',
  white: '#c9cde0',

  brightBlack: '#666e8c',
  brightRed: '#ff9d9d',
  brightGreen: '#8fe6bb',
  brightYellow: '#ffd79a',
  brightBlue: '#93a9ff',
  brightMagenta: '#c9a1ff',
  brightCyan: '#95e6ee',
  brightWhite: '#f2f4ff'
}
