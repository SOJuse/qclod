/**
 * Why Qclod is going away. A quit is deliberate (the person chose it) unless
 * Windows is ending the session or an update restarts it: then the tabs that
 * were working stay marked, and the next start carries on with them.
 */
export class QuitReason {
  private interrupted = false

  markInterrupted(): void {
    this.interrupted = true
  }

  get deliberate(): boolean {
    return !this.interrupted
  }
}
