import { SECTION_CAP, type PaletteItem, type PaletteProvider } from './types'
import { points, ranked } from './rank'

/**
 * The projects, by name. Enter goes to the project's last open chat;
 * a project with none gets a new chat in it (решение 17).
 */
export const projectsProvider: PaletteProvider = {
  section: 'projects',
  title: 'Проекты',
  items(query, ctx, alone = false) {
    // The mixed list without a query has no projects: the sidebar shows them already.
    if (query === '' && !alone) return []
    const shown =
      query === ''
        ? ctx.sidebar.slice(0, SECTION_CAP)
        : // By name only: a folder's path would fit every project under the same parent.
          ranked(ctx.sidebar, (p) => points(p.name, query))
    return shown.map((project): PaletteItem => {
      const last = project.chats[project.chats.length - 1]
      return {
        key: `project:${project.key}`,
        section: 'projects',
        title: project.name,
        hint: project.cwd,
        run: () => (last ? ctx.run.activateChat(last.id) : ctx.run.openProject(project.cwd))
      }
    })
  }
}
