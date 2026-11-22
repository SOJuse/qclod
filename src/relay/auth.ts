import type { ServerAuth } from '../shared/relayProtocol'
import type { Run } from './supervisor'

function firstJson(stdout: string): unknown {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * `claude auth status --json`, as the server's account. Probe 07 could not
 * reach the server (Ruling S6-R2): the fields are the ones Qclod already reads
 * locally (`loggedIn`, `email` — src/main/setup/auth.ts) and the plan under
 * `subscriptionType`, the name accountInfo() gives it (probe 07, step 1).
 * Anything unreadable is `loggedIn: null` — «не знаю», not «не вошёл».
 */
export function parseServerAuth(stdout: string): Pick<ServerAuth, 'loggedIn' | 'email' | 'plan'> {
  const parsed = firstJson(stdout)
  if (typeof parsed !== 'object' || parsed === null) return { loggedIn: null }
  const r = parsed as Record<string, unknown>
  if (typeof r['loggedIn'] !== 'boolean') return { loggedIn: null }
  const plan = [r['subscriptionType'], r['plan'], r['subscription']].find((v) => typeof v === 'string' && v !== '')
  return {
    loggedIn: r['loggedIn'],
    ...(typeof r['email'] === 'string' && r['email'] !== '' ? { email: r['email'] } : {}),
    ...(typeof plan === 'string' ? { plan } : {})
  }
}

/** «2.1.317 (Claude Code)» → 2.1.317. */
export function parseClaudeVersion(stdout: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1] ?? null
}

/** The server's Claude account and the claude the relay runs. No claude — all null (I14: said, not installed). */
export async function authStatus(run: Run, claudePath: string | null): Promise<ServerAuth> {
  if (!claudePath) return { loggedIn: null, claudePath: null, claudeVersion: null }
  let auth: Pick<ServerAuth, 'loggedIn' | 'email' | 'plan'> = { loggedIn: null }
  try {
    // Exits 1 when nobody is logged in; the JSON says so all the same.
    auth = parseServerAuth((await run(claudePath, ['auth', 'status', '--json'])).stdout)
  } catch {
    // Unknown.
  }
  let claudeVersion: string | null = null
  try {
    claudeVersion = parseClaudeVersion((await run(claudePath, ['--version'])).stdout)
  } catch {
    // Unknown.
  }
  return { ...auth, claudePath, claudeVersion }
}
