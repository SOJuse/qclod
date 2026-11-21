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
  | 'voice'

export interface AppActionInfo {
  id: AppActionId
  label: string
  keys?: string
}

/** The Ctrl+K (⌘K on a Mac) list, in the order it is shown. `tabAt` has no row: it is Ctrl+1…9. */
export const APP_ACTIONS: AppActionInfo[] = [
  { id: 'newTab', label: 'Новый чат', keys: 'Mod+T' },
  { id: 'closeTab', label: 'Закрыть чат', keys: 'Mod+W' },
  { id: 'nextTab', label: 'Следующий чат', keys: 'Ctrl+Tab' },
  { id: 'prevTab', label: 'Предыдущий чат', keys: 'Ctrl+Shift+Tab' },
  { id: 'actions', label: 'Палитра действий', keys: 'Mod+K' },
  { id: 'settings', label: 'Настройки', keys: 'Mod+,' },
  { id: 'history', label: 'Прошлые разговоры', keys: 'Mod+H' },
  { id: 'togglePanel', label: 'Показать или скрыть панель', keys: 'Mod+\\' },
  { id: 'toggleSidebar', label: 'Показать или скрыть боковую панель', keys: 'Mod+B' },
  { id: 'toggleSplit', label: 'Сплит: открыть рядом или закрыть', keys: 'Mod+Shift+Enter' },
  { id: 'restart', label: 'Перезапустить сессию' },
  { id: 'compact', label: 'Сжать контекст' },
  { id: 'cycleMode', label: 'Сменить режим', keys: 'Shift+Tab' },
  { id: 'voice', label: 'Голосовой ввод', keys: 'Ctrl+Пробел' },
  { id: 'zoomIn'
, label: 'Крупнее', keys: 'Mod+=' },
  { id: 'zoomOut', label: 'Мельче', keys: 'Mod+-' },
  { id: 'zoomReset', label: 'Обычный масштаб', keys: 'Mod+0' },
  { id: 'reload', label: 'Перезагрузить окно', keys: 'Mod+R' }
]

/** A tooltip with keys that are not a window action, such as Enter in the input. */
export function hintKeys(label: string, keys: string): string {
  return `${label} (${keys})`
}

export type Platform = 'win32' | 'darwin' | 'linux'

/** The platform the window runs on; the preload reads it from `process.platform`. */
export function currentPlatform(): Platform {
  const p = typeof window === 'undefined' ? undefined : window.qclod?.platform
  return p ?? 'win32'
}

const MAC_GLYPHS: Record<string, string> = {
  Mod: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Enter: '↩'
}

/**
 * Keys as written in APP_ACTIONS («Mod+Shift+Enter») for the person: «Ctrl+Shift+Enter»
 * on Windows and Linux, «⌘⇧↩» on a Mac. `Mod` is Cmd there and Ctrl elsewhere; a literal
 * `Ctrl` stays Ctrl (⌃ on a Mac).
 */
export function formatKeys(keys: string, platform: Platform): string {
  const parts = keys.split('+')
  // A trailing «+» is the key itself («Mod++»): the split leaves an empty tail.
  if (keys.endsWith('+')) parts.splice(parts.length - 2, 2, '+')
  if (platform === 'darwin') return parts.map((p) => MAC_GLYPHS[p] ?? p).join('')
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+')
}

/** The keys of an action as shown here; Cmd+H hides the app on a Mac, so history is Cmd+Y there. */
export function actionKeys(id: AppActionId, platform: Platform = currentPlatform()): string | undefined {
  const keys = APP_ACTIONS.find((a) => a.id === id)?.keys
  if (!keys) return undefined
  return formatKeys(id === 'history' && platform === 'darwin' ? 'Mod+Y' : keys, platform)
}

/** A button's tooltip: «Новый чат (Ctrl+T)», «Новый чат (⌘T)» on a Mac. */
export function hint(label: string, id?: AppActionId, platform: Platform = currentPlatform()): string {
  const keys = id ? actionKeys(id, platform) : undefined
  return keys ? hintKeys(label, keys) : label
}

/** Ctrl+9 is the last tab, as in a browser: the runner reads index 8 that way. */
export const LAST_TAB_INDEX = 8

/**
 * The window-level shortcut for a key press, by the PHYSICAL key so the Russian
 * layout works. Shift+Tab alone is the composer's (it cycles the mode there).
 */
export function resolveAppShortcut(
  ev: KeyLike,
  platform: Platform = currentPlatform()
): { id: AppActionId; index?: number } | null {
  if (ev.isComposing || ev.keyCode === 229) return null
  if (ev.altKey) return null

  const code = ev.code ?? ''
  // Tab between chats is the physical Ctrl everywhere: Cmd+Tab is the system's.
  if (code === 'Tab') {
    if (!ev.ctrlKey || ev.metaKey) return null
    return { id: ev.shiftKey ? 'prevTab' : 'nextTab' }
  }
  // Mod is Cmd on a Mac and Ctrl elsewhere, and the other one must be up (Ctrl+T on a Mac is not ours).
  if (platform === 'darwin' ? !ev.metaKey || ev.ctrlKey : !ev.ctrlKey || ev.metaKey) return null
  if (code === 'Enter' || code === 'NumpadEnter') {
    return ev.shiftKey ? { id: 'toggleSplit' } : null
  }
  // Zoom: Mod+= also arrives as Mod+Shift+= (the plus sign), so Shift is allowed here.
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
      return platform === 'darwin' ? null : { id: 'history' }
    case 'y':
      return platform === 'darwin' ? { id: 'history' } : null
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
