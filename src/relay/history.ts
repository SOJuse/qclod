import { SessionHistory, type SessionHistoryOptions } from '../main/agent/sessionHistory'

/**
 * The server's past conversations: the same SDK's listSessions({ dir }) the
 * desktop reads, with the same reduction to SessionSummary (F21: resumed
 * through session.open).
 */
export function relayHistory(listSessions: SessionHistoryOptions['listSessions']): SessionHistory {
  return new SessionHistory({ listSessions })
}
