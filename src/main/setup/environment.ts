import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AuthStatus, EnvironmentReport, ToolReport } from '../../shared/types'
import { AgentNotFoundError } from '../agent/resolveExecutable'
import { readAuthStatus } from './auth'
import { locateAgent } from './findAgent'
import { detectInstallMethod, type InstallMethod } from './install'

export type { EnvironmentReport, ToolReport }

const run = promisify(execFile)

export interface EnvironmentDeps {
  env?: NodeJS.ProcessEnv
  detect?: () => Promise<InstallMethod | null>
  /** Asked only when the agent is found, with its resolved path. */
  authStatus?: (agent: string) => Promise<AuthStatus>
}

/**
 * What this machine already has.
 *
 * One thing is required and it is the agent itself. Node is deliberately not
 * on this list: the Windows package needs none, so demanding it would be
 * asking someone to install a toolchain they will never use.
 */
export async function checkEnvironment(
  agentPath: string,
  deps: EnvironmentDeps = {}
): Promise<EnvironmentReport> {
  const env = deps.env ?? process.env
  const detect = deps.detect ?? detectInstallMethod
  const authStatus = deps.authStatus ?? readAuthStatus

  let path: string
  try {
    path = locateAgent(agentPath, env)
  } catch (err) {
    // On a clean machine "claude not found" is expected and the install step
    // speaks for it; only a wrapper that cannot be used, or a path the person
    // typed that leads nowhere, is worth saying out loud.
    const configured = agentPath.trim()
    const named = configured !== '' && configured !== 'claude'
    const problem =
      err instanceof AgentNotFoundError && (err.shim || named) ? err.message : undefined
    return {
      agent: { found: false, ...(problem ? { problem } : {}) },
      installMethod: await detect(),
      auth: null,
      ready: false
    }
  }

  let version: string | undefined
  try {
    // An older npm package is a cli.js, which only node can run.
    const [file, args] = /\.js$/i.test(path) ? ['node', [path, '--version']] : [path, ['--version']]
    const { stdout } = await run(file, args, { timeout: 20000, windowsHide: true })
    version = firstVersion(stdout)
  } catch {
    // On disk but would not answer. Still the agent we would run, so it is
    // reported as found rather than hidden.
  }

  // Only a definite "logged out" stops the work: an older CLI without
  // `auth status`, or one that would not answer, must not lock anyone out.
  const auth = await authStatus(path)

  // Nothing left to install, so nothing is asked of the machine.
  return {
    agent: { found: true, path, ...(version ? { version } : {}) },
    installMethod: null,
    auth,
    ready: auth !== 'out'
  }
}

/** `2.1.268 (Claude Code)` → `2.1.268`. */
function firstVersion(output: string): string | undefined {
  const match = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(output)
  return match ? match[0] : output.trim().split('\n')[0]?.trim() || undefined
}
