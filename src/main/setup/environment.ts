import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { findAgent } from './findAgent'
import { detectInstallMethod, type InstallMethod } from './install'

const run = promisify(execFile)

export interface ToolReport {
  found: boolean
  version?: string
  path?: string
}

export interface EnvironmentReport {
  agent: ToolReport
  /** How this machine can install it, if it has to. */
  installMethod: InstallMethod | null
  /** True when Qclod has an agent to drive. */
  ready: boolean
}

/**
 * What this machine already has.
 *
 * One thing is required and it is the agent itself. Node is deliberately not
 * on this list: the Windows package needs none, so demanding it would be
 * asking someone to install a toolchain they will never use.
 */
export async function checkEnvironment(agentPath: string): Promise<EnvironmentReport> {
  const path = findAgent(agentPath, process.env)
  if (!path) {
    return { agent: { found: false }, installMethod: await detectInstallMethod(), ready: false }
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

  // Nothing left to install, so nothing is asked of the machine.
  return { agent: { found: true, path, ...(version ? { version } : {}) }, installMethod: null, ready: true }
}

/** `2.1.268 (Claude Code)` → `2.1.268`. */
function firstVersion(output: string): string | undefined {
  const match = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(output)
  return match ? match[0] : output.trim().split('\n')[0]?.trim() || undefined
}
