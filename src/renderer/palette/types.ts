import type { CommandInfo, SessionSummary, TabId } from '../../shared/types'
import type { AppActionId } from '../app/shortcuts'
import type { SidebarProject } from '../chat/sidebarModel'
import type { PaneLayerState } from '../state/useAppStore'

/** id источника; заголовок раздела — `title` источника. Свои: 'chats' | 'projects' | 'history' | 'files' | 'servers' | 'commands'; этапы 6–7 добавляют свои строкой в PALETTE_PROVIDERS. */
export type PaletteSection = string

/** One row of Ctrl+K: what it says, where it belongs, what Enter does. */
export interface PaletteItem {
  key: string
  section: PaletteSection
  title: string
  /** The dim second part of the row: a project, a folder, when. */
  hint?: string
  /** A window action's keys, shown on the right. */
  keys?: string
  run(): void
}

/** What a row can do in the window; App gives it, the palette closes before any of it runs. */
export interface PaletteRunner {
  activateChat(id: TabId): void
  /** A new chat in this folder. */
  openProject(cwd: string): void
  openSession(cwd: string, s: SessionSummary): void
  insertMention(path: string): void
  insertCommand(name: string): void
  /** Действие окна; arg — для действий с объектом (например, id сервера у этапа 6). */
  runAction(id: AppActionId, arg?: string): void
  /** Слой поверх ленты активной панели (задача 6). */
  openLayer(layer: PaneLayerState): void
}

export interface PaletteContext {
  sidebar: SidebarProject[]
  activeTabId: TabId
  /** The active chat's file index. */
  files: string[]
  /** The active chat's slash commands. */
  commands: CommandInfo[]
  run: PaletteRunner
}

export interface PaletteProvider {
  section: PaletteSection
  title: string
  /** Typed first, it keeps the search to this section alone: `>` commands, `@` files. */
  prefix?: string
  /**
   * The rows for `query` — already trimmed and lower-cased, without the prefix.
   * `alone`: the section is shown by itself (Ctrl+H, a prefix), so an empty
   * query may list more of it than the mixed list does.
   */
  items(query: string, ctx: PaletteContext, alone?: boolean): PaletteItem[]
}

/** At most this many rows per section. */
export const SECTION_CAP = 8
