import type { PaletteItem, PaletteProvider } from './types'
import { points, ranked } from './rank'

/**
 * Stage 6: the servers. «Сервер <label>» opens the folder picker there (a new
 * chat on it), «Терминал <label>» its terminal (task 26) — both through
 * `runAction` with the server's id (сверка F16).
 */
export const serversProvider: PaletteProvider = {
  section: 'servers',
  title: 'Серверы',
  items(query, ctx, alone = false) {
    const servers = ctx.servers ?? []
    if (servers.length === 0 || (query === '' && !alone)) return []
    const shown =
      query === ''
        ? servers
        : ranked(servers, (s) => {
            const byLabel = points(s.label, query)
            const byTarget = points(s.target, query)
            return byLabel === null ? byTarget : byTarget === null ? byLabel : Math.max(byLabel, byTarget)
          })
    return shown.flatMap((server): PaletteItem[] => [
      {
        key: `server:${server.id}`,
        section: 'servers',
        title: `Сервер ${server.label}`,
        hint: server.target,
        run: () => ctx.run.runAction('openServerFolder', server.id)
      },
      {
        key: `server-terminal:${server.id}`,
        section: 'servers',
        title: `Терминал ${server.label}`,
        hint: server.target,
        run: () => ctx.run.runAction('openServerTerminal', server.id)
      }
    ])
  }
}
