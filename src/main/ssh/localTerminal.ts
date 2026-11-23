/**
 * A local chat's terminal: the same drawer and hub as the server's, a shell of
 * this computer in the chat's folder instead of ssh. Windows — pwsh.exe when it
 * is on PATH, else powershell.exe; Mac and Linux — `$SHELL -l`, else zsh.
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface LocalShell {
  file: string
  args: string[]
}

export function findOnPath(name: string, pathVar: string, exists: (p: string) => boolean = existsSync): string | null {
  for (const dir of pathVar.split(delimiter)) {
    if (dir && exists(join(dir, name))) return join(dir, name)
  }
  return null
}

export function localShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync
): LocalShell {
  if (platform === 'win32') {
    const pwsh = findOnPath('pwsh.exe', env['PATH'] ?? env['Path'] ?? '', exists)
    return { file: pwsh ?? 'powershell.exe', args: [] }
  }
  const shell = env['SHELL']
  return { file: shell && shell.startsWith('/') ? shell : '/bin/zsh', args: ['-l'] }
}

const PROXY_VARS = /^(https?_proxy|all_proxy|no_proxy|ftp_proxy|socks_proxy)$/i

/** Qclod's environment for the terminal, without the VPN's proxy variables. */
export function localTerminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !PROXY_VARS.test(k)) out[k] = v
  return out
}
