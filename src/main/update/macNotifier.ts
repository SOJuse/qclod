import type { UpdateState } from '../../shared/types'
import { UPDATE_FIRST_CHECK_MS, UPDATE_RECHECK_MS } from './updater'

export const RELEASES_LATEST = 'https://api.github.com/repos/SOJuse/qclod/releases/latest'

/** The only release page the banner will send the person to. */
const RELEASE_URL = /^https:\/\/github\.com\/SOJuse\/qclod\/releases\/tag\/v\d+\.\d+\.\d+$/
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

function parts(version: string): [number, number, number] | null {
  const m = SEMVER.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** x.y.z against x.y.z; anything else (a pre-release, a word) is never newer. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate)
  const b = parts(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

/**
 * What GitHub's «latest release» says, reduced to a version and a link. Anything
 * unexpected (a tag that is not vX.Y.Z, a page that is not ours) is null: the
 * link is opened in the browser, so it is checked, not trusted.
 */
export function parseLatestRelease(json: unknown, current: string): { version: string; url: string } | null {
  if (json === null || typeof json !== 'object') return null
  const { tag_name: tag, html_url: url } = json as { tag_name?: unknown; html_url?: unknown }
  if (typeof tag !== 'string' || typeof url !== 'string') return null
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  if (!SEMVER.test(version) || !RELEASE_URL.test(url)) return null
  return isNewer(version, current) ? { version, url } : null
}

/** e2e only: `QCLOD_FAKE_UPDATE` = `{ "available": "9.9.9" }` stands in for GitHub; null for anything else. */
export function parseFakeAvailable(spec: string | undefined): string | null {
  if (!spec) return null
  try {
    const v = (JSON.parse(spec) as { available?: unknown }).available
    return typeof v === 'string' && SEMVER.test(v) ? v : null
  } catch {
    return null
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * A Mac build is not signed and does not update itself: it only looks at the
 * latest release now and then and says that there is a newer one, with a link.
 * A failed look (no network, a rate limit) is one line in the log.
 */
export class MacUpdateNotifier {
  private current: UpdateState = { kind: 'idle' }
  private readonly setTimer: (fn: () => void, ms: number) => unknown

  constructor(
    private readonly deps: {
      fetchJson: (url: string) => Promise<unknown>
      currentVersion: string
      onState: (s: UpdateState) => void
      log: (m: string) => void
      setTimer?: (fn: () => void, ms: number) => unknown
    }
  ) {
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms)
        timer.unref()
        return timer
      })
  }

  get state(): UpdateState {
    return this.current
  }

  start(delayMs: number = UPDATE_FIRST_CHECK_MS): void {
    this.setTimer(() => void this.check(), delayMs)
  }

  private async check(): Promise<void> {
    this.setTimer(() => void this.check(), UPDATE_RECHECK_MS)
    try {
      const found = parseLatestRelease(await this.deps.fetchJson(RELEASES_LATEST), this.deps.currentVersion)
      if (!found) return
      if (this.current.kind === 'available' && this.current.version === found.version) return
      this.current = { kind: 'available', version: found.version, url: found.url }
      this.deps.onState(this.current)
    } catch (err) {
      this.deps.log(`проверка новой версии не удалась: ${messageOf(err)}`)
    }
  }
}
