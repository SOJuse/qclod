import type { AppSettings } from '../../shared/types'

export interface ResolvedAgent {
  path: string
  prefixArgs: string[]
}

/**
 * Where the agent executable comes from, resolved fresh on every session start.
 *
 * It must not be captured once at startup: the error panel's "open settings →
 * restart" loop (spec 6.10) is the user's only way to recover from a wrong
 * path, and a pinned value makes that loop unwinnable.
 *
 * Tests substitute the fake agent through the environment, so the e2e suite
 * never launches the real CLI (Global Constraints). A malformed value is
 * ignored rather than thrown: this runs before the window exists, and an
 * exception here would leave the user with no window and no explanation.
 */
export function resolveAgent(settings: AppSettings): ResolvedAgent {
  const override = process.env['QCLOD_AGENT_PATH']
  const path = override && override.trim() !== '' ? override.trim() : settings.agentPath

  let prefixArgs: string[] = []
  const raw = process.env['QCLOD_AGENT_PREFIX_ARGS']
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        prefixArgs = parsed
      }
    } catch {
      /* ignore: a broken test seam must not stop the app from starting */
    }
  }

  return { path, prefixArgs }
}
