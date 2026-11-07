import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveExecutable } from '../agent/resolveExecutable'

/**
 * Where Claude Code ends up, besides PATH.
 *
 * A process inherits PATH when it starts, so an agent installed *while Qclod
 * is running* is invisible to it until a restart — which would make the setup
 * screen lie right after it succeeded. These are the places the official
 * installers put it, checked directly.
 */
function knownLocations(env: NodeJS.ProcessEnv): string[] {
  const local = env['LOCALAPPDATA'] ?? ''
  const home = env['USERPROFILE'] ?? env['HOME'] ?? ''
  const appData = env['APPDATA'] ?? ''
  const places: string[] = []

  // winget puts a shim in Links and the real thing under Packages.
  if (local) {
    places.push(join(local, 'Microsoft', 'WinGet', 'Links', 'claude.exe'))
    const packages = join(local, 'Microsoft', 'WinGet', 'Packages')
    try {
      for (const entry of readdirSync(packages)) {
        if (!entry.startsWith('Anthropic.ClaudeCode')) continue
        places.push(join(packages, entry, 'claude.exe'))
        places.push(join(packages, entry, 'claude'))
      }
    } catch {
      // No winget packages directory: nothing to add.
    }
  }

  // The native installer, and npm's global bin.
  if (home) {
    places.push(join(home, '.local', 'bin', 'claude.exe'))
    places.push(join(home, '.local', 'bin', 'claude'))
  }
  if (appData) {
    places.push(join(appData, 'npm', 'claude.cmd'))
    places.push(join(appData, 'npm', 'claude'))
  }

  return places
}

/**
 * The agent's executable, or null if this machine has none.
 *
 * PATH first — a path the user typed into settings, or an agent that was
 * already there — then the places an installer would have put it.
 */
export function findAgent(configured: string, env: NodeJS.ProcessEnv): string | null {
  const wanted = configured.trim() || 'claude'

  try {
    return resolveExecutable(wanted, env)
  } catch {
    // Not on PATH. If the user typed a full path and it is wrong, saying so is
    // better than quietly running some other agent they did not name.
    if (wanted !== 'claude') return null
  }

  for (const candidate of knownLocations(env)) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
