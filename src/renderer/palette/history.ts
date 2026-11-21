import { shortWhen } from '../../shared/format'
import type { SessionSummary } from '../../shared/types'
import type { SidebarProject } from '../chat/sidebarModel'
import { pastLabel } from '../components/sidebar/PastRow'
import { SECTION_CAP, type PaletteItem, type PaletteProvider } from './types'
import { bestOf, contains, points, ranked } from './rank'

/** How many past conversations the mixed list shows before anything is typed. */
export const RECENT_PAST = 5
/** Opening the palette reads the history of at most this many projects not read yet. */
export const HISTORY_PREFETCH = 20

/** The folders whose past conversations nobody has asked for yet, first ones first; a server's with its id (stage 6). */
export function historyToLoad(sidebar: SidebarProject[]): Array<{ cwd: string; hostId?: string }> {
  return sidebar
    .filter((p) => p.past === null)
    .slice(0, HISTORY_PREFETCH)
    .map((p) => (p.remote ? { cwd: p.cwd, hostId: p.remote.hostId } : { cwd: p.cwd }))
}

/**
 * Past conversations of every project, newest first, by title and by the
 * first message. Enter opens one (openProjectSession).
 */
export const historyProvider: PaletteProvider = {
  section: 'history',
  title: 'Прошлые разговоры',
  items(query, ctx, alone = false) {
    const all: Array<{ session: SessionSummary; project: SidebarProject }> = ctx.sidebar
      .flatMap((project) => (Array.isArray(project.past) ? project.past.map((session) => ({ session, project })) : []))
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
    const shown =
      query === ''
        ? all.slice(0, alone ? SECTION_CAP : RECENT_PAST)
        : ranked(all, ({ session }) => bestOf(points(session.title, query), contains(session.firstMessage, query)))
    return shown.map(
      ({ session, project }): PaletteItem => ({
        key: `past:${project.key}:${session.id}`,
        section: 'history',
        title: pastLabel(session),
        hint: `${project.name} · ${shortWhen(session.updatedAt)}`,
        // A server project's conversation resumes on that server (сверка F21).
        run: () =>
          project.remote
            ? ctx.run.openSession(project.cwd, session, project.remote.hostId)
            : ctx.run.openSession(project.cwd, session)
      })
    )
  },
  // Nothing to list yet is not «nothing found»: a read still under way, or one that failed and can be retried.
  state(ctx) {
    if (ctx.sidebar.some((p) => p.past === 'loading')) return { kind: 'loading' }
    const failed = ctx.sidebar.filter(
      (p): p is SidebarProject & { past: { error: string } } =>
        p.past !== null && p.past !== 'loading' && !Array.isArray(p.past)
    )
    if (failed.length === 0) return null
    return {
      kind: 'error',
      title: 'Не удалось прочитать историю',
      reason: failed[0]!.past.error,
      retry: () => {
        for (const p of failed) {
          if (p.remote) ctx.run.loadHistory(p.cwd, p.remote.hostId)
          else ctx.run.loadHistory(p.cwd)
        }
      }
    }
  }
}
