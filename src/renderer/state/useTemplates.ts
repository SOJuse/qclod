import { useSyncExternalStore } from 'react'
import type { PromptTemplate } from '../../shared/types'

/**
 * The owner's templates as main keeps them: read once, then followed through
 * `templates:changed`. One copy for the whole window — the `/` list of every
 * pane, Ctrl+K and the manager all read the same list.
 */
let current: PromptTemplate[] = []
let started = false
/** A change came from main: the first read, still on its way, is older. */
let changed = false
const listeners = new Set<() => void>()

function set(list: PromptTemplate[]): void {
  current = list
  for (const cb of listeners) cb()
}

function start(): void {
  if (started) return
  started = true
  window.qclod.onTemplatesChanged((list) => {
    changed = true
    set(list)
  })
  window.qclod
    .templatesList()
    .then((list) => {
      if (!changed) set(list)
    })
    .catch((err: unknown) => {
      console.warn('[templates]', err instanceof Error ? err.message : String(err))
    })
}

function subscribe(cb: () => void): () => void {
  start()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function snapshot(): PromptTemplate[] {
  return current
}

export function useTemplates(): PromptTemplate[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The list right now, outside React. */
export function templatesNow(): PromptTemplate[] {
  return current
}
