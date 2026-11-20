import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import type { TabId, TabState } from '../shared/types'

export interface TrayDeps {
  getWindow: () => BrowserWindow | null
  getTabs: () => TabState[]
  onActivateTab: (id: TabId) => void
  toggleWindow: () => void
}

/** The tray mark's colour: the app's accent (tokens.css). */
const TRAY_RGB = [0x6e, 0x8b, 0xff] as const

/**
 * A rounded square in the accent colour, as raw BGRA pixels of one size.
 * Anti-aliased over one pixel at the edge.
 */
export function trayBitmap(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4)
  const inset = size * 0.1875
  const radius = size * 0.1875
  const lo = inset
  const hi = size - inset
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const cx = Math.min(Math.max(px, lo + radius), hi - radius)
      const cy = Math.min(Math.max(py, lo + radius), hi - radius)
      const alpha = Math.min(Math.max(radius - Math.hypot(px - cx, py - cy) + 0.5, 0), 1)
      const at = (y * size + x) * 4
      // BGRA, premultiplied: Windows composites the tray icon that way.
      pixels[at] = Math.round(TRAY_RGB[2] * alpha)
      pixels[at + 1] = Math.round(TRAY_RGB[1] * alpha)
      pixels[at + 2] = Math.round(TRAY_RGB[0] * alpha)
      pixels[at + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

/**
 * Drawn here as a bitmap so the build does not depend on an icon file being
 * present. Not an SVG: Electron reads only PNG and JPEG from a data URL, and
 * an SVG one came out as an empty image — the tray had no icon at all.
 * 16 px plus 1.5x and 2x copies, so it stays sharp at any display scale.
 */
function trayIcon(): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  for (const scaleFactor of [1, 1.5, 2]) {
    const size = Math.round(16 * scaleFactor)
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: trayBitmap(size) })
  }
  return image
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
