const DEFAULT_LIMIT = 500

/**
 * Recall of what was sent from the composer. Position −1 means "not browsing";
 * 0 is the most recent entry.
 */
export class InputHistory {
  private items: string[] = []
  private position = -1

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  get size(): number {
    return this.items.length
  }

  /** Oldest first, the order a person would read them in. */
  get entries(): string[] {
    return [...this.items].reverse()
  }

  push(text: string): void {
    this.position = -1
    if (text.trim() === '') return
    if (this.items[0] === text) return
    this.items.unshift(text)
    if (this.items.length > this.limit) this.items.length = this.limit
  }

  prev(): string | undefined {
    if (this.items.length === 0) return undefined
    this.position = Math.min(this.position + 1, this.items.length - 1)
    return this.items[this.position]
  }

  next(): string | undefined {
    if (this.position < 0) return undefined
    this.position -= 1
    // Stepping past the newest entry lands back on the empty draft.
    return this.position < 0 ? '' : this.items[this.position]
  }

  reset(): void {
    this.position = -1
  }
}
