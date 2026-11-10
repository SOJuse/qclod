import { importEsm } from '../esm'
import type { SessionSummary } from '../../shared/types'

interface SdkSessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  customTitle?: string
  firstPrompt?: string
}

export interface SessionHistoryOptions {
  listSessions: (options: { dir: string }) => Promise<SdkSessionInfo[]>
}

/**
 * Past conversations, read from where the CLI already keeps them.
 *
 * Qclod stores none of this itself — it only asks. That is what lets the
 * history screen exist without Qclod ever writing a line of anyone's
 * conversation to disk (constraint 5.4).
 *
 * The list swallows its errors: a session file someone deleted, renamed or
 * corrupted must leave the user with an empty list, never with a dead screen.
 */
export class SessionHistory {
  constructor(private readonly options: SessionHistoryOptions) {}

  async list(cwd: string): Promise<SessionSummary[]> {
    let sessions: SdkSessionInfo[]
    try {
      sessions = await this.options.listSessions({ dir: cwd })
    } catch {
      return []
    }

    return sessions.map((session) => ({
      id: session.sessionId,
      title: session.customTitle || session.summary || session.firstPrompt || 'Без названия',
      firstMessage: session.firstPrompt ?? '',
      updatedAt: session.lastModified
    }))
  }
}

/** The real one, talking to the SDK's session files. */
export async function createSessionHistory(): Promise<SessionHistory> {
  const sdk = await importEsm<typeof import('@anthropic-ai/claude-agent-sdk')>(
    '@anthropic-ai/claude-agent-sdk'
  )
  return new SessionHistory({
    listSessions: (options) => sdk.listSessions(options) as Promise<SdkSessionInfo[]>
  })
}
