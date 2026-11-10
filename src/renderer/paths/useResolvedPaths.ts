import { useEffect, useMemo } from 'react'
import type { ResolvedPath, TabId } from '../../shared/types'
import { pathSettled, useAppStore } from '../state/useAppStore'

/** Texts every visible row wants, gathered for a moment and asked in one go. */
const DEBOUNCE_MS = 50
/** What main answers per call (PathResolver); more waits for the next call. */
const BATCH = 200

const waiting = new Map<TabId, Set<string>>()
const asking = new Map<TabId, Set<string>>()
const timers = new Map<TabId, ReturnType<typeof setTimeout>>()

function flush(tabId: TabId): void {
  timers.delete(tabId)
  const raws = [...(waiting.get(tabId) ?? [])]
  waiting.delete(tabId)
  let flying = asking.get(tabId)
  if (!flying) asking.set(tabId, (flying = new Set()))
  for (let i = 0; i < raws.length; i += BATCH) {
    const chunk = raws.slice(i, i + BATCH)
    for (const raw of chunk) flying.add(raw)
    void window.qclod
      .resolvePaths(tabId, chunk)
      .then((answers) => {
        useAppStore.getState().setPaths(
          tabId,
          chunk.map((raw, j) => [raw, answers[j] ?? null] as const)
        )
      })
      // An answer that never came is asked again by the next row that shows it.
      .catch(() => undefined)
      .finally(() => {
        for (const raw of chunk) flying.delete(raw)
      })
  }
}

/** Puts texts main has not been asked about into the next batch. */
function ask(tabId: TabId, raws: readonly string[]): void {
  const known = useAppStore.getState().pathsByTab[tabId]
  const flying = asking.get(tabId)
  let queue = waiting.get(tabId)
  for (const raw of raws) {
    if (pathSettled(known?.get(raw)) || flying?.has(raw) || queue?.has(raw)) continue
    if (!queue) waiting.set(tabId, (queue = new Set()))
    queue.add(raw)
  }
  if (queue && queue.size > 0 && !timers.has(tabId)) {
    timers.set(tabId, setTimeout(() => flush(tabId), DEBOUNCE_MS))
  }
}

/**
 * Which of these candidate texts are files or folders on disk, for this tab.
 *
 * Asks main about the ones it has not answered yet and remembers every
 * answer. A "no" holds for a short while (MISSING_TTL_MS) and until a call
 * that writes files finishes in the tab: agents name a file before making it.
 * Pass no texts for a text that is still streaming:
 * a half-written path is not worth a lookup.
 */
export function useResolvedPaths(tabId: TabId, raws: string[]): ReadonlyMap<string, ResolvedPath> {
  const known = useAppStore((s) => s.pathsByTab[tabId])
  const key = raws.join('\n')

  // `key` stands for `raws`: a new array with the same texts asks nothing new.
  // A change in what is known asks again about whatever is no longer settled:
  // a write elsewhere in the tab drops the "no"s, and a "no" goes stale.
  useEffect(() => {
    if (tabId && raws.length > 0) ask(tabId, raws)
  }, [tabId, key, known])

  return useMemo(() => {
    const found = new Map<string, ResolvedPath>()
    if (!known) return found
    for (const raw of raws) {
      const target = known.get(raw)?.target
      if (target) found.set(raw, target)
    }
    return found
  }, [known, key])
}

/**
 * The path as main sees it now, asked just before acting on it. Asking again
 * renews the tab's right to act on it (PathResolver grants expire) and
 * catches a file deleted since: then the link goes back to being text and
 * nothing happens.
 */
export async function freshTarget(tabId: TabId, target: ResolvedPath): Promise<ResolvedPath | null> {
  const [answer] = await window.qclod.resolvePaths(tabId, [target.raw]).catch(() => [null])
  const fresh = answer ?? null
  useAppStore.getState().setPaths(tabId, [[target.raw, fresh]])
  return fresh
}
