import { physicalKey } from '../input/physicalKey'
import type { KeyLike } from '../input/keyPrecedence'

/** Everything the window can do from the keyboard or from the Ctrl+K list. */
export type AppActionId =
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'tabAt'
  | 'actions'
  | 'settings'
  | 'history'
  | 'togglePanel'
  | 'toggleSidebar'
  | 'toggleSplit'
  | 'restart'
  | 'compact'
  | 'cycleMode'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'reload'
  // этап 7: шаблоны
  | 'templates'
  | 'saveDraftAsTemplate'
  | 'harvestTemplates'

export interface AppActionInfo {
  id: AppActionId
  label: string
  keys?: string
}

/** The Ctrl+K list, in the order it is shown. `tabAt` has no row: it is Ctrl+1…9. */
export const APP_ACTIONS: AppActionInfo[] = [
  { id: 'newTab', label: 'Новый чат', keys: 'Ctrl+T' },
  { id: 'closeTab', label: 'Закрыть чат', keys: 'Ctrl+W' },
  { id: 'nextTab', label: 'Следующий чат', keys: 'Ctrl+Tab' },
  { id: 'prevTab', label: 'Предыдущий чат', keys: 'Ctrl+Shift+Tab' },
  { id: 'actions', label: 'Палитра действий', keys: 'Ctrl+K' },
  { id: 'settings', label: 'Настройки', keys: 'Ctrl+,' },
  { id: 'history', label: 'Прошлые разговоры', keys: 'Ctrl+H' },
  { id: 'togglePanel', label: 'Показать или скрыть панель', keys: 'Ctrl+\\' },
  { id: 'toggleSidebar', label: 'Показать или скрыть боковую панель', keys: 'Ctrl+B' },
  { id: 'toggleSplit', label: 'Сплит: открыть рядом или закрыть', keys: 'Ctrl+Shift+Enter' },
  { id: 'restart', label: 'Перезапустить сессию' },
  { id: 'compact', label: 'Сжать контекст' },
  { id: 'cycleMode', label: 'Сменить режим', keys: 'Shift+Tab' },
  { id: 'zoomIn', label: 'Крупнее', keys: 'Ctrl+=' },
  { id: 'zoomOut', label: 'Мельче', keys: 'Ctrl+-' },
  { id: 'zoomReset', label: 'Обычный масштаб', keys: 'Ctrl+0' },
  { id: 'reload', label: 'Перезагрузить окно', keys: 'Ctrl+R' },
  // этап 7: шаблоны
  { id: 'templates', label: 'Шаблоны' },
  { id: 'saveDraftAsTemplate', label: 'Сохранить черновик как шаблон' },
  { id: 'harvestTemplates', label: 'Собрать мои шаблоны' }
]

/** A tooltip with keys that are not a window action, such as Enter in the input. */
export function hintKeys(label: string, keys: string): string {
  return `${label} (${keys})`
}

/** A button's tooltip: «Новый чат (Ctrl+T)». */
export function hint(label: string, id?: AppActionId): string {
  const keys = id ? APP_ACTIONS.find((a) => a.id === id)?.keys : undefined
  return keys ? hintKeys(label, keys) : label
}

/** Ctrl+9 is the last tab, as in a browser: the runner reads index 8 that way. */
export const LAST_TAB_INDEX = 8

/**
 * The window-level shortcut for a key press, by the PHYSICAL key so the Russian
 * layout works. Shift+Tab alone is the composer's (it cycles the mode there).
 */
export function resolveAppShortcut(
  ev: KeyLike
): { id: AppActionId; index?: number } | null {
  if (ev.isComposing || ev.keyCode === 229) return null
  if (!ev.ctrlKey || ev.altKey || ev.metaKey) return null

  const code = ev.code ?? ''
  if (code === 'Tab') return { id: ev.shiftKey ? 'prevTab' : 'nextTab' }
  if (code === 'Enter' || code === 'NumpadEnter') {
    return ev.shiftKey ? { id: 'toggleSplit' } : null
  }
  // Zoom: Ctrl+= also arrives as Ctrl+Shift+= (the plus sign), so Shift is allowed here.
  if (code === 'Equal' || code === 'NumpadAdd') return { id: 'zoomIn' }
  if (code === 'Minus' || code === 'NumpadSubtract') return { id: 'zoomOut' }
  if (code === 'Digit0' || code === 'Numpad0') return { id: 'zoomReset' }
  if (ev.shiftKey) return null

  if (code === 'Comma') return { id: 'settings' }
  if (code === 'Backslash') return { id: 'togglePanel' }

  const k = physicalKey(ev)
  if (/^[1-9]$/.test(k)) return { id: 'tabAt', index: Number(k) - 1 }
  switch (k) {
    case 't':
      return { id: 'newTab' }
    case 'w':
      return { id: 'closeTab' }
    case 'k':
      return { id: 'actions' }
    case 'h':
      return { id: 'history' }
    case 'b':
      return { id: 'toggleSidebar' }
    case 'r':
      return { id: 'reload' }
    default:
      return null
  }
}

/** The chat Ctrl+1…9 picks, in the sidebar's order: index 8 is the last one, a missing index picks nothing. */
export function tabAtTarget(tabIds: string[], index: number | undefined): string | null {
  if (index === undefined) return null
  const at = index === LAST_TAB_INDEX ? tabIds.length - 1 : index
  return tabIds[at] ?? null
}
