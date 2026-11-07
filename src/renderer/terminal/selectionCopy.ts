/**
 * Decides when a terminal selection should reach the clipboard.
 *
 * Spec 6.5 asks for copy-on-release of a MOUSE selection. Copying on every
 * selection change also fires for Ctrl+A and mid-drag, so pressing Ctrl+A to
 * look at the scrollback would silently replace whatever the user had copied.
 */
export class SelectionCopyGate {
  private dragging = false
  private selected = false

  pointerDown(): void {
    this.dragging = true
    this.selected = false
  }

  /** @returns whether to copy now (never: copying waits for release). */
  selectionChanged(): boolean {
    if (this.dragging) this.selected = true
    return false
  }

  /** @returns whether the released drag produced something to copy. */
  pointerUp(): boolean {
    const copy = this.dragging && this.selected
    this.dragging = false
    this.selected = false
    return copy
  }

  /** Ctrl+A and friends select without the user asking for a copy. */
  programmaticSelect(): void {
    this.dragging = false
    this.selected = false
  }
}
