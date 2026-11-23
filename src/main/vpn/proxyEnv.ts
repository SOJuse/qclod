// 1.0.1: vpn — what Claude Code's process is given, and the back-off of the client's restarts.

export const NO_PROXY = 'localhost,127.0.0.1,::1'

/** Env for the local Claude Code process with the VPN on; Qclod's own process is untouched. */
export function claudeProxyEnv(httpPort: number): Record<string, string> {
  const url = `http://127.0.0.1:${httpPort}`
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    NO_PROXY,
    no_proxy: NO_PROXY
  }
}

/** process.env with the proxy over it; without a proxy — undefined (the SDK passes the app's own). */
export function withProxyEnv(
  base: Record<string, string | undefined>,
  proxy: Record<string, string> | null
): Record<string, string | undefined> | undefined {
  if (!proxy) return undefined
  const out: Record<string, string | undefined> = {}
  // Windows env names are case-insensitive: a user's own Https_Proxy must not survive next to ours.
  for (const [k, v] of Object.entries(base)) if (!/^(https?|all|no)_proxy$/i.test(k)) out[k] = v
  return { ...out, ...proxy }
}

export const BACKOFF_S: readonly number[] = [2, 5, 15, 30]

/** Delay before restart number `attempt` (0-based), ms. */
export function backoffMs(attempt: number): number {
  return BACKOFF_S[Math.min(Math.max(attempt, 0), BACKOFF_S.length - 1)]! * 1000
}
