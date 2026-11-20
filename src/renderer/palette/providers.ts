import { chatsProvider } from './chats'
import { commandsProvider } from './commands'
import { filesProvider } from './files'
import { historyProvider } from './history'
import { projectsProvider } from './projects'
import { SECTION_CAP, type PaletteContext, type PaletteItem, type PaletteProvider, type PaletteSection } from './types'

/**
 * The sections of Ctrl+K, in the order they are shown. A later stage's
 * section (servers, этап 6) is one more line here: the palette draws its
 * heading from the provider's own `title`.
 */
export const PALETTE_PROVIDERS: PaletteProvider[] = [
  chatsProvider,
  projectsProvider,
  historyProvider,
  filesProvider,
  commandsProvider
]

/** A section's heading; the id itself for a section nobody provides. */
export function sectionTitle(section: PaletteSection): string {
  return PALETTE_PROVIDERS.find((p) => p.section === section)?.title ?? section
}

/**
 * Every section's rows for what was typed, section by section, at most
 * SECTION_CAP each. `scope` keeps it to one section (Ctrl+H: the past ones);
 * without it, a prefix (`>`, `@`) does the same.
 */
export function searchPalette(query: string, ctx: PaletteContext, scope?: PaletteSection): PaletteItem[] {
  let text = query
  let only = scope
  if (only === undefined) {
    const byPrefix = PALETTE_PROVIDERS.find((p) => p.prefix !== undefined && text.startsWith(p.prefix))
    if (byPrefix) {
      only = byPrefix.section
      text = text.slice(byPrefix.prefix!.length)
    }
  }
  const needle = text.trim().toLowerCase()
  const alone = only !== undefined
  return PALETTE_PROVIDERS.filter((p) => !alone || p.section === only).flatMap((p) =>
    p.items(needle, ctx, alone).slice(0, SECTION_CAP)
  )
}
