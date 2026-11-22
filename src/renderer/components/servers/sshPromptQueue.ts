import { useCallback, useEffect, useState } from 'react'
import type { SshPrompt, SshPromptAnswer } from '../../../shared/types'

/**
 * The questions ssh asks, in order, the first one shown (stage 6). A question
 * main took back — it timed out, ssh exited, the attempt was cancelled — goes
 * from the queue without an answer (R4): a dialog for a question nobody
 * waits on any more would take a password into nowhere.
 */
export function useSshPrompts(): [SshPrompt | null, (answer: SshPromptAnswer) => void] {
  const [queue, setQueue] = useState<SshPrompt[]>([])
  useEffect(() => {
    const drop = (promptId: string): void => setQueue((all) => all.filter((p) => p.promptId !== promptId))
    const offs = [
      window.qclod.onSshPrompt((prompt) =>
        setQueue((all) => (all.some((p) => p.promptId === prompt.promptId) ? all : [...all, prompt]))
      ),
      window.qclod.onSshPromptClosed((e) => drop(e.promptId))
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [])
  const answer = useCallback((reply: SshPromptAnswer): void => {
    void window.qclod.answerSshPrompt(reply).catch(() => undefined)
    setQueue((all) => all.filter((p) => p.promptId !== reply.promptId))
  }, [])
  return [queue[0] ?? null, answer]
}
