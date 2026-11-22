import type { ServerConnState } from '../../shared/types'

/**
 * When the active tab's file index (for @-mentions) is asked for. A local
 * folder's is asked once. A server's waits for the server to be on line, and
 * is asked again each time it comes back: what came before may be stale, or
 * empty because the line was down (stage 6, Minor).
 * `serverState` — null for a local tab.
 */
export function fileIndexAsk(o: { cached: boolean; serverState: ServerConnState | null; cameOnline: boolean }): boolean {
  if (o.serverState === null) return !o.cached
  if (o.serverState !== 'online') return false
  return !o.cached || o.cameOnline
}

/** An empty answer from a server is not kept: it is asked again rather than taken for an empty folder. */
export function fileIndexKept(serverState: ServerConnState | null, paths: string[]): boolean {
  return serverState === null || paths.length > 0
}
