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

/** The folders whose past conversations nobody has asked for yet, first ones first. */
export function historyToLoad(sidebar: SidebarProject[]): string[] {
  return sidebar
    .filter((p) => p.past === null)
    .slice(0, HISTORY_PREFETCH)
    .map((p) => p.cwd)
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
        run: () => ctx.run.openSession(project.cwd, session)
      })
    )
  }
}
