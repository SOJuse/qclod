import { chatsProvider } from './chats'
import { commandsProvider } from './commands'
import { filesProvider } from './files'
import { historyProvider } from './history'
import { projectsProvider } from './projects'
import { serversProvider } from './servers'
import { fold } from './rank'
import {
  SECTION_CAP,
  type PaletteContext,
  type PaletteItem,
  type PaletteProvider,
  type PaletteSection,
  type PaletteSectionState
} from './types'

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
  serversProvider,
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
  const { only, needle } = resolve(query, scope)
  const alone = only !== undefined
  return PALETTE_PROVIDERS.filter((p) => !alone || p.section === only).flatMap((p) =>
    p.items(needle, ctx, alone).slice(0, SECTION_CAP)
  )
}

/**
 * Why the one section shown by itself (scope or prefix) has nothing yet —
 * still read, or the read failed; null in the mixed list or when nothing is pending.
 * Asked only when the search found no rows.
 */
export function paletteState(query: string, ctx: PaletteContext, scope?: PaletteSection): PaletteSectionState | null {
  const { only } = resolve(query, scope)
  if (only === undefined) return null
  return PALETTE_PROVIDERS.find((p) => p.section === only)?.state?.(ctx) ?? null
}

/** The one section asked for (scope, else a prefix) and the needle without that prefix. */
function resolve(query: string, scope?: PaletteSection): { only: PaletteSection | undefined; needle: string } {
  let text = query
  let only = scope
  if (only === undefined) {
    const byPrefix = PALETTE_PROVIDERS.find((p) => p.prefix !== undefined && text.startsWith(p.prefix))
    if (byPrefix) {
      only = byPrefix.section
      text = text.slice(byPrefix.prefix!.length)
    }
  }
  return { only, needle: fold(text.trim()) }
}
