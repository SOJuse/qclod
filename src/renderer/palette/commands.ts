import { APP_ACTIONS, actionKeys } from '../app/shortcuts'
import { SECTION_CAP, type PaletteItem, type PaletteProvider } from './types'
import { bestOf, points, ranked } from './rank'

/**
 * The draft with `/name ` in front: a command is read only at the start of
 * the input. Whatever was typed stays after it, as the command's argument.
 */
export function withCommand(draft: string, name: string): string {
  const rest = draft.replace(/^\s+/, '')
  return `/${name} ${rest}`
}

/**
 * The window's own actions by their label, then the active chat's slash
 * commands as «/name — описание». An action runs; a slash command goes into
 * the input for the person to send. Ctrl+K itself has no row: it is open.
 */
export const commandsProvider: PaletteProvider = {
  section: 'commands',
  title: 'Команды',
  prefix: '>',
  items(query, ctx) {
    const actions = APP_ACTIONS.filter((a) => a.id !== 'actions').map(
      (action): { row: PaletteItem; name?: string } => ({
        row: {
          key: `action:${action.id}`,
          section: 'commands',
          title: action.label,
          ...(action.keys ? { keys: actionKeys(action.id) } : {}),
          run: () => ctx.run.runAction(action.id)
        }
      })
    )
    if (query === '') return actions.slice(0, SECTION_CAP).map((a) => a.row)
    const slash = ctx.commands.map((command): { row: PaletteItem; name?: string } => ({
      name: command.name,
      row: {
        key: `slash:${command.name}`,
        section: 'commands',
        title: command.description ? `/${command.name} — ${command.description}` : `/${command.name}`,
        run: () => ctx.run.insertCommand(command.name)
      }
    }))
    return ranked([...actions, ...slash], ({ row, name }) =>
      bestOf(points(row.title, query), name === undefined ? null : points(name, query))
    ).map((a) => a.row)
  }
}
