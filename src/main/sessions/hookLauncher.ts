import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HOOK_LAUNCHER_NAME = 'qclod-hook.cmd'

/**
 * Claude Code runs hook commands through the shell, and the only interpreter
 * Qclod can rely on being present is its own Electron binary — the user may
 * have no standalone Node. Electron runs a plain script only when
 * ELECTRON_RUN_AS_NODE is set, which a command line cannot carry portably, so
 * the hook command points at this generated shim instead.
 */
export function writeHookLauncher(dir: string, execPath: string, scriptPath: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, HOOK_LAUNCHER_NAME)
  const body = [
    '@echo off',
    'setlocal',
    'set ELECTRON_RUN_AS_NODE=1',
    `"${execPath}" "${scriptPath}" %*`,
    ''
  ].join('\r\n')
  writeFileSync(path, body, 'utf8')
  return path
}

/**
 * Maps a path inside the packaged `app.asar` to its unpacked twin.
 * ELECTRON_RUN_AS_NODE runs plain Node, which cannot read a script out of an
 * asar archive, so `bin/` is unpacked at build time.
 */
export function unpackedPath(path: string): string {
  if (path.includes('app.asar.unpacked')) return path

  // Built from its code point rather than written as an escape: a lone
  // backslash in source is too easy to lose in transit.
  const BACKSLASH = String.fromCharCode(92)
  for (const separator of ['/', BACKSLASH]) {
    const needle = `app.asar${separator}`
    const at = path.indexOf(needle)
    if (at === -1) continue
    return (
      path.slice(0, at) + `app.asar.unpacked${separator}` + path.slice(at + needle.length)
    )
  }
  return path
}
