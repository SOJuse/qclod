/**
 * The system the window runs on, as far as voice cares: the «Голос» settings
 * and the voice key are Windows-only (G11). The preload's `window.qclod.platform`
 * answers; a page without the preload (unit tests) reads the user agent.
 */
export function voicePlatform(): string {
  const fromPreload = typeof window !== 'undefined' ? window.qclod?.platform : undefined
  if (fromPreload) return fromPreload
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')) return 'win32'
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')) return 'darwin'
  return 'linux'
}

export function isWindows(): boolean {
  return voicePlatform() === 'win32'
}
