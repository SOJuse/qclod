import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus, SessionStatus, TabId } from '../../../shared/types'
import { useAppStore } from '../../state/useAppStore'

/** Git is asked at most this often per chat: extra asks are folded into one. */
export const GIT_MIN_GAP_MS = 2_000

/** A turn ended: the agent may have changed files. */
export function turnEnded(before: SessionStatus | undefined, now: SessionStatus | undefined): boolean {
  return before === 'busy' && now === 'idle'
}

export interface GitStatusFeed {
  /** Ask for the status; within the gap of the last ask, the asks fold into one that waits for the gap. */
  refresh(): void
  /** Ask now, whatever the gap (after a commit). */
  refreshNow(): void
  dispose(): void
}

/** The throttle on its own, so it can be tested with fake timers. */
export function createGitStatusFeed(deps: {
  fetch: () => Promise<GitStatus>
  onStatus: (s: GitStatus) => void
  minGapMs?: number
}): GitStatusFeed {
  const gap = deps.minGapMs ?? GIT_MIN_GAP_MS
  let lastAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let generation = 0

  const run = (): void => {
    timer = null
    lastAt = Date.now()
    const mine = ++generation
    deps
      .fetch()
      .then((s) => {
        // An older answer never lands over a newer one.
        if (!disposed && mine === generation) deps.onStatus(s)
      })
      .catch(() => {
        if (!disposed && mine === generation) deps.onStatus({ kind: 'error', message: 'Не удалось спросить Git.' })
      })
  }

  return {
    refresh() {
      if (disposed || timer !== null) return
      const wait = Math.max(0, lastAt + gap - Date.now())
      if (wait === 0) run()
      else timer = setTimeout(run, wait)
    },
    refreshNow() {
      if (disposed) return
      if (timer !== null) clearTimeout(timer)
      run()
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
  }
}

/**
 * The chat's git status: asked on mount, when the chat's turn ends
 * (busy → idle), when the window gets the focus, and on `refresh`.
 */
export function useGitStatus(tabId: TabId): {
  status: GitStatus | null
  refresh: () => void
  refreshNow: () => void
} {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const feed = useRef<GitStatusFeed | null>(null)

  useEffect(() => {
    setStatus(null)
    const f = createGitStatusFeed({ fetch: () => window.qclod.gitStatus(tabId), onStatus: setStatus })
    feed.current = f
    f.refresh()
    const onFocus = (): void => f.refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      f.dispose()
      feed.current = null
    }
  }, [tabId])

  const session: SessionStatus | undefined = useAppStore((s) => s.tabs.find((t) => t.id === tabId)?.status)
  const before = useRef<SessionStatus | undefined>(session)
  useEffect(() => {
    if (turnEnded(before.current, session)) feed.current?.refresh()
    before.current = session
  }, [session])

  const refresh = useCallback(() => feed.current?.refresh(), [])
  const refreshNow = useCallback(() => feed.current?.refreshNow(), [])
  return { status, refresh, refreshNow }
}
