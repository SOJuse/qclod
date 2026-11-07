import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalize } from 'node:path'

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

function samePath(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase()
}

/**
 * Decides whether the window may navigate to a URL. Compares structurally
 * rather than by string prefix: a prefix test lets `http://localhost:5173.evil.com`
 * and `file://remote-host/<our path>` through.
 *
 * @param devServerUrl ELECTRON_RENDERER_URL when running from the dev server.
 * @param appFilePath  absolute path of the packaged renderer entry file.
 */
export function makeNavigationGuard(
  devServerUrl: string | undefined,
  appFilePath: string
): (url: string) => boolean {
  const expectedOrigin = devServerUrl ? safeOrigin(devServerUrl) : undefined
  const expectedFile = fileURLToPath(pathToFileURL(appFilePath))

  return (url: string): boolean => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return false
    }

    if (expectedOrigin !== undefined) {
      return target.origin === expectedOrigin
    }

    // `host` must be empty: a non-empty host makes this a UNC path pointing at
    // another machine, which would load a remote page with our preload attached.
    if (target.protocol !== 'file:' || target.host !== '') return false
    try {
      return samePath(fileURLToPath(target), expectedFile)
    } catch {
      return false
    }
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
