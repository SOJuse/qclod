/**
 * Why a session died before it introduced itself, read from the agent's own
 * words (the raw error, before `explain` rewords it).
 *
 * The answer decides what the tab does next. A conversation that is gone is
 * worth replacing with a clean one. An agent that is not logged in is not:
 * a clean session would die the same way, so the tab keeps its conversation
 * and waits for the user to log in and try again.
 */
/**
 * What a tab says when its agent is not logged in, with «Войти» beside it.
 * One text whichever way the tab got there, so the tab can tell it has said
 * it already.
 */
export const LOGIN_NEEDED_TEXT =
  'Claude Code не вошёл в аккаунт. Нажмите «Войти» — после входа вкладка продолжит сама.'

export type StartFailure = 'missing-conversation' | 'not-logged-in' | 'other'

export function classifyStartFailure(message: string): StartFailure {
  if (/no conversation found|session .* not found/i.test(message)) return 'missing-conversation'
  if (/not logged in|please run \/login|invalid api key|authentication_error|unauthorized/i.test(message)) {
    return 'not-logged-in'
  }
  return 'other'
}
