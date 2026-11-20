import { SECTION_CAP, type PaletteItem, type PaletteProvider } from './types'
import { points, ranked } from './rank'

/** The draft with `@path ` added at its end, a space before it when the text needs one. */
export function withMention(draft: string, path: string): string {
  const gap = draft === '' || /\s$/.test(draft) ? '' : ' '
  return `${draft}${gap}@${path} `
}

/** The active chat's files, by path; Enter puts `@path ` into its input. */
export const filesProvider: PaletteProvider = {
  section: 'files',
  title: 'Файлы',
  prefix: '@',
  items(query, ctx, alone = false) {
    if (query === '' && !alone) return []
    const shown = query === '' ? ctx.files.slice(0, SECTION_CAP) : ranked(ctx.files, (path) => points(path, query))
    return shown.map((path): PaletteItem => {
      const slash = path.lastIndexOf('/')
      return {
        key: `file:${path}`,
        section: 'files',
        title: path.slice(slash + 1),
        ...(slash > 0 ? { hint: path.slice(0, slash) } : {}),
        run: () => ctx.run.insertMention(path)
      }
    })
  },
  state: (ctx) => (ctx.filesPending ? { kind: 'loading' } : null)
}
