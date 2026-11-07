import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import type { TabId, TabState } from '../shared/types'

export interface TrayDeps {
  getWindow: () => BrowserWindow | null
  getTabs: () => TabState[]
  onActivateTab: (id: TabId) => void
  toggleWindow: () => void
}

/**
 * A 16px dot in the app's accent colour, drawn here so the build does not
 * depend on an icon file being present (and so it stays in step with tokens).
 */
function trayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <rect x="3" y="3" width="10" height="10" rx="3" fill="#6E8BFF"/>
  </svg>`
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
}

export function createTray(deps: TrayDeps): Tray {
  const tray = new Tray(trayIcon())
  tray.setToolTip('Qclod')

  const rebuild = (): void => {
    const tabs = deps.getTabs()
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Показать Qclod', click: deps.toggleWindow },
        { type: 'separator' },
        ...(tabs.length === 0
          ? [{ label: 'Нет вкладок', enabled: false } as Electron.MenuItemConstructorOptions]
          : tabs.map((tab) => ({
              label: `${tab.badge ? '• ' : ''}${tab.title}`,
              click: () => deps.onActivateTab(tab.id)
            }))),
        { type: 'separator' },
        { label: 'Выйти', click: () => app.quit() }
      ])
    )
  }

  rebuild()
  tray.on('click', deps.toggleWindow)

  return Object.assign(tray, { rebuild }) as Tray & { rebuild: () => void }
}
