import type { MenuItemConstructorOptions } from 'electron'

export type MenuActionId = 'settings' | 'newTab'

/**
 * The application menu. A Mac must have one: without «Правка» ⌘C, ⌘V and ⌘Z do
 * nothing in the input fields. It carries no Close, Reload or Zoom items: their
 * accelerators would fight the window's own keys. Elsewhere there is no menu.
 */
export function appMenuTemplate(
  platform: NodeJS.Platform,
  deps: { onAction(id: MenuActionId): void; version: string }
): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null
  return [
    {
      label: 'Qclod',
      submenu: [
        { label: 'О программе Qclod', role: 'about' },
        { type: 'separator' },
        {
          label: 'Настройки…',
          accelerator: 'Cmd+,',
          // The window handles the key itself (shortcuts.ts); the menu only shows it and answers a click.
          registerAccelerator: false,
          click: () => deps.onAction('settings')
        },
        { type: 'separator' },
        { label: 'Службы', role: 'services' },
        { type: 'separator' },
        { label: 'Скрыть Qclod', role: 'hide' },
        { label: 'Скрыть остальные', role: 'hideOthers' },
        { label: 'Показать все', role: 'unhide' },
        { type: 'separator' },
        { label: 'Завершить Qclod', role: 'quit' }
      ]
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Отменить', role: 'undo' },
        { label: 'Повторить', role: 'redo' },
        { type: 'separator' },
        { label: 'Вырезать', role: 'cut' },
        { label: 'Копировать', role: 'copy' },
        { label: 'Вставить', role: 'paste' },
        { label: 'Выделить всё', role: 'selectAll' }
      ]
    },
    {
      label: 'Окно',
      submenu: [
        { label: 'Свернуть', role: 'minimize' },
        { label: 'Масштаб', role: 'zoom' },
        { type: 'separator' },
        { label: 'Все окна — на передний план', role: 'front' }
      ]
    }
  ]
}
