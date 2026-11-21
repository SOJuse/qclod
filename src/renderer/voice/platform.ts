/**
 * The system the window runs on, as far as voice cares: Win+H and the
 * «Голос» settings are Windows-only (G11). The preload has no platform yet;
 * этап 6 (task 1) puts `window.qclod.platform` in and replaces this.
 */
export function isWindows(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
}

export function voicePlatform(): string {
  if (isWindows()) return 'win32'
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')) return 'darwin'
  return 'linux'
}
