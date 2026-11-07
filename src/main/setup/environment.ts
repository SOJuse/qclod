import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveExecutable } from '../agent/resolveExecutable'

const run = promisify(execFile)

export interface ToolReport {
  found: boolean
  version?: string
  path?: string
}

export interface EnvironmentReport {
  node: ToolReport
  npm: ToolReport
  agent: ToolReport
  /** True when everything Qclod needs to talk to an agent is present. */
  ready: boolean
}

/**
 * What this machine already has.
 *
 * Qclod does not bundle Claude Code: it drives the one the user is logged into,
 * with their settings, their plugins and their account. So a fresh machine
 * needs it installed, and someone being handed this app should be told that in
 * words rather than meeting an error the first time they type something.
 */
export async function checkEnvironment(agentPath: string): Promise<EnvironmentReport> {
  const [node, npm, agent] = await Promise.all([
    probe('node', ['--version']),
    probe('npm', ['--version']),
    probe(agentPath || 'claude', ['--version'])
  ])

  return { node, npm, agent, ready: agent.found }
}

/** Looks a tool up the way a spawn would, then asks it its version. */
async function probe(command: string, args: string[]): Promise<ToolReport> {
  let path: string
  try {
    path = resolveExecutable(command, process.env)
  } catch {
    return { found: false }
  }

  try {
    const { stdout } = await run(path, args, { timeout: 20000, windowsHide: true })
    return { found: true, path, version: firstVersion(stdout) }
  } catch {
    // It is on disk but would not answer: present enough to show, not enough
    // to promise it works.
    return { found: true, path }
  }
}

/** `2.1.268 (Claude Code)` → `2.1.268`; `v24.18.0` → `24.18.0`. */
function firstVersion(output: string): string | undefined {
  const match = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(output)
  return match ? match[0] : output.trim().split('\n')[0]?.trim() || undefined
}
