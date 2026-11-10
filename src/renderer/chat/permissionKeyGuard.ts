/** How long after the card takes focus its keys stay dead. */
export const ARM_MS = 400

/**
 * Keys that are physically down right now, by `code`. Kept from the start of
 * the page, so that when a card appears we know which keys were already held:
 * an Enter someone is still pressing for the input line must not approve a
 * request that appeared under their finger.
 */
const down = new Set<string>()
/** Sets of keys held at some card's focus; a key-up removes it from each. */
const watchers = new Set<Set<string>>()

export function heldKeys(): ReadonlySet<string> {
  return down
}

let tracking = false
export function trackHeldKeys(): void {
  if (tracking || typeof window === 'undefined') return
  tracking = true
  window.addEventListener(
    'keydown',
    (ev) => {
      down.add(ev.code || ev.key)
    },
    true
  )
  window.addEventListener(
    'keyup',
    (ev) => {
      const code = ev.code || ev.key
      down.delete(code)
      for (const held of watchers) held.delete(code)
    },
    true
  )
  window.addEventListener('blur', () => down.clear())
}

export interface KeyGuard {
  /** The card has just taken focus; `held` are the keys already down. */
  focus(now: number, held: ReadonlySet<string>): void
  /** A key-up for this physical key was seen. */
  released(code: string): void
  /** May a key-down for this physical key answer the card? */
  allows(code: string, now: number): boolean
  dispose(): void
}

export function createKeyGuard(): KeyGuard {
  let focusedAt: number | null = null
  let held = new Set<string>()
  return {
    focus(now, current) {
      focusedAt = now
      watchers.delete(held)
      held = new Set(current)
      watchers.add(held)
    },
    released(code) {
      held.delete(code)
    },
    allows(code, now) {
      return focusedAt !== null && now - focusedAt >= ARM_MS && !held.has(code)
    },
    dispose() {
      watchers.delete(held)
    }
  }
}
