const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:'])

/**
 * Only ever hand plain web URLs to the OS. A renderer-supplied string can name
 * any registered protocol handler, and `shell.openExternal` would launch it.
 */
export function isSafeExternalUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return EXTERNAL_PROTOCOLS.has(parsed.protocol)
}
