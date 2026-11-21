// The relay manifest from the .gz files' sha256 lines: shared by
// scripts/relay-manifest.mjs and its test.

/** qclod-relay-<version>-linux-<x64|arm64>.gz */
export const ASSET = /^qclod-relay-(.+)-linux-(x64|arm64)\.gz$/

/**
 * @param {string} version
 * @param {Array<{ name: string; sha256Line: string; size: number }>} files
 */
export function manifestFrom(version, files) {
  /** @type {Record<string, { name: string; sha256: string; size: number }>} */
  const assets = {}
  for (const file of files) {
    const match = ASSET.exec(file.name)
    if (!match || match[1] !== version) continue
    const sha256 = file.sha256Line.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${file.name}: не sha256`)
    assets[match[2]] = { name: file.name, sha256, size: file.size }
  }
  return { version, assets }
}
