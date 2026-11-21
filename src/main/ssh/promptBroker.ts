/**
 * The questions ssh asks (askpass), on their way to the window and back.
 * One answer per question: an answer to a question nobody asked — another
 * id, a second click — does nothing. A window that is gone answers «нет».
 */
import type { SshPrompt, SshPromptAnswer } from '../../shared/types'

/** Nobody answers in this long: ssh is told «нет» (it gives up itself soon after). */
export const PROMPT_TIMEOUT_MS = 5 * 60_000

export class SshPromptBroker {
  private readonly open = new Map<string, (a: SshPromptAnswer) => void>()

  constructor(
    private readonly show: (p: SshPrompt) => boolean,
    private readonly timeoutMs = PROMPT_TIMEOUT_MS
  ) {}

  ask(p: SshPrompt): Promise<SshPromptAnswer> {
    return new Promise((resolve) => {
      const done = (a: SshPromptAnswer): void => {
        if (!this.open.has(p.promptId)) return
        this.open.delete(p.promptId)
        clearTimeout(timer)
        resolve(a)
      }
      const timer = setTimeout(() => done({ promptId: p.promptId, ok: false }), this.timeoutMs)
      timer.unref?.()
      this.open.set(p.promptId, done)
      if (!this.show(p)) done({ promptId: p.promptId, ok: false })
    })
  }

  /** True when it answered an open question. */
  answer(a: SshPromptAnswer): boolean {
    const done = this.open.get(a.promptId)
    if (!done) return false
    done(a)
    return true
  }

  /** The window went away: every open question is a «нет». */
  cancelAll(): void {
    for (const [promptId, done] of [...this.open]) done({ promptId, ok: false })
  }
}
