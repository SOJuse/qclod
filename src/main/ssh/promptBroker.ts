/**
 * The questions ssh asks (askpass), on their way to the window and back.
 * One answer per question: an answer to a question nobody asked — another
 * id, a second click — does nothing. A window that is gone answers «нет».
 *
 * A question that ends without the window's answer — its time ran out, ssh
 * gave up or exited, the app is closing — is said to be gone (`onClosed`,
 * R4): the window drops its dialog instead of keeping one nobody reads.
 */
import type { SshPrompt, SshPromptAnswer } from '../../shared/types'

/** Nobody answers in this long: ssh is told «нет» (it gives up itself soon after). */
export const PROMPT_TIMEOUT_MS = 5 * 60_000

export class SshPromptBroker {
  private readonly open = new Map<string, (a: SshPromptAnswer, byWindow: boolean) => void>()

  constructor(
    private readonly show: (p: SshPrompt) => boolean,
    private readonly timeoutMs = PROMPT_TIMEOUT_MS,
    private readonly onClosed?: (promptId: string) => void
  ) {}

  ask(p: SshPrompt): Promise<SshPromptAnswer> {
    return new Promise((resolve) => {
      let shown = false
      const done = (a: SshPromptAnswer, byWindow: boolean): void => {
        if (!this.open.has(p.promptId)) return
        this.open.delete(p.promptId)
        clearTimeout(timer)
        if (shown && !byWindow) this.onClosed?.(p.promptId)
        resolve(a)
      }
      const timer = setTimeout(() => done({ promptId: p.promptId, ok: false }, false), this.timeoutMs)
      timer.unref?.()
      this.open.set(p.promptId, done)
      shown = this.show(p)
      if (!shown) done({ promptId: p.promptId, ok: false }, false)
    })
  }

  /** True when it answered an open question. */
  answer(a: SshPromptAnswer): boolean {
    const done = this.open.get(a.promptId)
    if (!done) return false
    done(a, true)
    return true
  }

  /** The question is void (ssh is gone): «нет», and the window is told. */
  cancel(promptId: string): void {
    this.open.get(promptId)?.({ promptId, ok: false }, false)
  }

  /** The window went away: every open question is a «нет». */
  cancelAll(): void {
    for (const [promptId, done] of [...this.open]) done({ promptId, ok: false }, false)
  }
}
