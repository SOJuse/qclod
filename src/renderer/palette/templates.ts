import { templateHits } from '../input/templates'
import type { PaletteItem, PaletteProvider } from './types'

/**
 * The owner's templates in Ctrl+K: Enter puts the text in the active chat's
 * input at the caret, its first `{{…}}` selected. Nothing typed — the mixed
 * list keeps to its own rows; the section by itself lists the newest.
 */
export const templatesProvider: PaletteProvider = {
  section: 'templates',
  title: 'Шаблоны',
  items(query, ctx, alone = false) {
    const templates = ctx.templates ?? []
    if (query === '' && !alone) return []
    const bodies = new Map(templates.map((t) => [t.id, t.body]))
    return templateHits(templates, query).map(
      (hit): PaletteItem => ({
        key: `template:${hit.id}`,
        section: 'templates',
        title: hit.title,
        ...(hit.preview ? { hint: hit.preview } : {}),
        run: () => ctx.run.insertTemplate(bodies.get(hit.id) ?? '')
      })
    )
  }
}
