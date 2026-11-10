import type { RibbonChange, RibbonEvent, TabId } from '../shared/types'

/**
 * Coalesces ribbon changes before they cross IPC.
 *
 * An agent replaying a long session, or simply working fast, produces changes
 * far quicker than a screen can show them. Sending each one as its own message
 * makes the renderer serialise, deserialise and re-render thousands of times,
 * and the window stops answering — the exact freeze this rewrite exists to
 * remove. One message per frame costs the same to look at and nothing to wait
 * for.
 */
export class RibbonBatcher {
  private readonly queued = new Map<TabId, { changes: RibbonChange[]; rev: number }>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly flushTo: (event: RibbonEvent) => void,
    private readonly frameMs = 16
  ) {}

  push(event: RibbonEvent): void {
    if (event.changes.length === 0) return
    const existing = this.queued.get(event.tabId)
    if (existing) {
      existing.changes.push(...event.changes)
      // The batch is as new as its newest change: the rev was given when the
      // change was made, not now, so a snapshot taken meanwhile already has it.
      existing.rev = Math.max(existing.rev, event.rev)
    } else this.queued.set(event.tabId, { changes: [...event.changes], rev: event.rev })

    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.frameMs)
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const [tabId, { changes, rev }] of this.queued) this.flushTo({ tabId, changes, rev })
    this.queued.clear()
  }
}
