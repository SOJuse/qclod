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
