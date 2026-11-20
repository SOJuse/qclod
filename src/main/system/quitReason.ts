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

/**
 * Windows is ending the session (shutdown, sign-out). before-quit may never
 * come then, so the cores are stopped here: a CLI that dies before Qclod
 * must not be restarted in the middle of a shutdown. `working` stays for
 * the next start (decision 8).
 */
export function sessionEnding(reason: QuitReason, autonomy: { quitting(deliberate: boolean): void }): void {
  reason.markInterrupted()
  autonomy.quitting(false)
}
