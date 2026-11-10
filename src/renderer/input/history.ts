const DEFAULT_LIMIT = 500

/**
 * Recall of what was sent from a tab's input. Position −1 means "not
 * browsing"; 0 is the most recent entry. The draft being typed when browsing
 * starts is kept and handed back after the newest entry, so ↓ never loses it.
 */
export class InputHistory {
  /** Newest first. */
  private items: string[] = []
  private position = -1
  private draft = ''
  /** The recalled entry was edited: ↓ now leaves the history for the draft. */
  private edited = false

  constructor(
    entries: string[] = [],
    private readonly limit: number = DEFAULT_LIMIT
  ) {
    this.setEntries(entries)
  }

  get size(): number {
    return this.items.length
  }

  /** Oldest first, the order a person would read them in. */
  get entries(): string[] {
    return [...this.items].reverse()
  }

  /**
   * Replaces the entries (oldest first), as the tab's own messages are the
   * source of truth. Browsing, if it is going on, keeps its place.
   */
  setEntries(entries: string[]): void {
    const kept: string[] = []
    for (const text of entries) {
      if (text.trim() === '') continue
      if (kept[kept.length - 1] === text) continue
      kept.push(text)
    }
    const next = kept.reverse().slice(0, this.limit)
    // Newer entries shift the older ones; browsing stays on the same entry.
    if (this.position >= 0) this.position += next.length - this.items.length
    this.items = next
    if (this.position >= this.items.length) this.position = this.items.length - 1
    if (this.position < 0) this.position = -1
  }

  push(text: string): void {
    this.reset()
    if (text.trim() === '') return
    if (this.items[0] === text) return
    this.items.unshift(text)
    if (this.items.length > this.limit) this.items.length = this.limit
  }

  /** `draft` is what is in the field now; it is remembered on the first step. */
  prev(draft: string): string | undefined {
    if (this.items.length === 0) return undefined
    if (this.position < 0) this.draft = draft
    this.edited = false
    this.position = Math.min(this.position + 1, this.items.length - 1)
    return this.items[this.position]
  }

  next(): string | undefined {
    if (this.position < 0) return undefined
    if (this.edited) {
      this.reset()
      return this.draft
    }
    this.position -= 1
    return this.position < 0 ? this.draft : this.items[this.position]
  }

  /** The person typed into a recalled entry; the held draft stays. */
  edit(): void {
    if (this.position >= 0) this.edited = true
  }

  reset(): void {
    this.position = -1
    this.edited = false
  }
}
