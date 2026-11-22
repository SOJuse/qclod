import type { CommandInfo, HistoryHit, PromptTemplate, ServerView, SessionSummary, TabId } from '../../shared/types'
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
  /** этап 7: a row that says something but does nothing («Ищу в разговорах…»). */
  disabled?: boolean
  /** этап 7: the part of `title` to show marked (a search match). */
  mark?: { start: number; length: number }
  run(): void
}

/** What a row can do in the window; App gives it, the palette closes before any of it runs. */
export interface PaletteRunner {
  activateChat(id: TabId): void
  /** A new chat in this folder; hostId — on that server (R8). */
  openProject(cwd: string, hostId?: string): void
  /** hostId — a server project's (stage 6). */
  openSession(cwd: string, s: SessionSummary, hostId?: string): void
  insertMention(path: string): void
  insertCommand(name: string): void
  /** этап 7: a template's text into the active chat's input at the caret; no active chat — nothing. */
  insertTemplate(body: string): void
  /** Действие окна; arg — для действий с объектом (например, id сервера у этапа 6). */
  runAction(id: AppActionId, arg?: string): void
  /** Слой поверх ленты активной панели (задача 6). */
  openLayer(layer: PaneLayerState): void
  /** Reads a project's past conversations again («Повторить» after a failed read). */
  loadHistory(cwd: string, hostId?: string): void
}

/** Why a section shown by itself has no rows yet: still read, or the read failed. */
export type PaletteSectionState =
  | { kind: 'loading' }
  | { kind: 'error'; title: string; reason: string; retry(): void }

export interface PaletteContext {
  sidebar: SidebarProject[]
  activeTabId: TabId
  /** The active chat's file index. */
  files: string[]
  /** The file index has not come yet. */
  filesPending?: boolean
  /** The active chat's slash commands. */
  commands: CommandInfo[]
  /** Stage 6: the servers Qclod knows. */
  servers?: ServerView[]
  /** этап 7: the owner's prompt templates. */
  templates?: PromptTemplate[]
  /** этап 7: the active chat's input has text («Сохранить черновик как шаблон»). */
  hasDraft?: boolean
  /** этап 7: the latest answer of the search over past conversations, for `query` (folded). */
  historyText?: { query: string; hits: HistoryHit[]; pending: boolean } | null
  /** этап 7: what is typed in the palette, as typed; the search over history waits for 300 ms of quiet. */
  onQuery?(query: string): void
  run: PaletteRunner
}

export interface PaletteProvider {
  section: PaletteSection
  title: string
  /** Typed first, it keeps the search to this section alone: `>` commands, `@` files. */
  prefix?: string
  /**
   * The rows for `query` — already trimmed, lower-cased and «ё» as «е» (rank.fold), without the prefix.
   * `alone`: the section is shown by itself (Ctrl+H, a prefix), so an empty
   * query may list more of it than the mixed list does.
   */
  items(query: string, ctx: PaletteContext, alone?: boolean): PaletteItem[]
  /** Shown by itself with no rows: why, instead of «Ничего не нашлось»; null — nothing pending. */
  state?(ctx: PaletteContext): PaletteSectionState | null
}

/** At most this many rows per section. */
export const SECTION_CAP = 8
