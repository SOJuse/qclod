import { SECTION_CAP, type PaletteItem, type PaletteProvider } from './types'
import { bestOf, points, ranked } from './rank'

/** The open chats, by their title or their project's name; Enter makes one active. */
export const chatsProvider: PaletteProvider = {
  section: 'chats',
  title: 'Чаты',
  items(query, ctx) {
    const all = ctx.sidebar.flatMap((project) => project.chats.map((chat) => ({ chat, project })))
    const shown =
      query === ''
        ? all.slice(0, SECTION_CAP)
        : ranked(all, ({ chat, project }) => bestOf(points(chat.title, query), points(project.name, query)))
    return shown.map(
      ({ chat, project }): PaletteItem => ({
        key: `chat:${chat.id}`,
        section: 'chats',
        title: chat.title,
        // A new chat is called after its folder: the project's name a second time says nothing.
        ...(project.name === chat.title ? {} : { hint: project.name }),
        run: () => ctx.run.activateChat(chat.id)
      })
    )
  }
}
