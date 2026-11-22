import { shortWhen } from '../../shared/format'
import type { PaletteItem, PaletteProvider } from './types'

/** Typed at least this much, the past conversations are searched by their text. */
export const HISTORY_TEXT_MIN = 3

/**
 * «В разговорах»: the full-text search over past conversations (main's
 * HistorySearch). It answers later than the rest of Ctrl+K, so the App keeps
 * the latest answer in the context; until it is for this very query the
 * section says it is looking. Enter opens the session as a chat.
 */
export const historyTextProvider: PaletteProvider = {
  section: 'historyText',
  title: 'В разговорах',
  items(query, ctx) {
    if (query.length < HISTORY_TEXT_MIN) return []
    const state = ctx.historyText
    if (!state || state.pending || state.query !== query) {
      return [
        {
          key: 'historyText:pending',
          section: 'historyText',
          title: 'Ищу в разговорах…',
          disabled: true,
          run: () => undefined
        }
      ]
    }
    return state.hits.map((hit): PaletteItem => {
      const head = `${hit.title} — `
      return {
        key: `historyText:${hit.cwd}:${hit.sessionId}`,
        section: 'historyText',
        title: `${head}${hit.snippet}`,
        mark: { start: head.length + hit.matchStart, length: hit.matchLength },
        hint: `${hit.projectLabel} · ${shortWhen(hit.updatedAt)}`,
        run: () =>
          ctx.run.openSession(hit.cwd, { id: hit.sessionId, title: hit.title, firstMessage: '', updatedAt: hit.updatedAt })
      }
    })
  }
}
