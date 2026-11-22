import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { TabId, TabState } from '../shared/types'
import { TRAY_GLYPH } from './brand/trayGlyph'

export type TrayStatus = 'idle' | 'working' | 'waiting' | 'error'
/** The glyph's tone: dark is for a light taskbar. */
export type TrayTone = 'dark' | 'light'

export interface TrayDeps {
  getWindow: () => BrowserWindow | null
  getTabs: () => TabState[]
  onActivateTab: (id: TabId) => void
  toggleWindow: () => void
  /** The glyph's tone for the current taskbar. */
  getTone: () => TrayTone
  /** The machine is being kept awake for the agents (system/keepAwake.ts). */
  isKeepingAwake?: () => boolean
}

export const KEEP_AWAKE_LABEL = 'Не даю компьютеру уснуть — агенты работают'

const GLYPH_RGB: Record<TrayTone, readonly [number, number, number]> = {
  dark: [0x1b, 0x1b, 0x1f],
  light: [0xff, 0xff, 0xff]
}
const DOT_RGB: Record<Exclude<TrayStatus, 'idle'>, readonly [number, number, number]> = {
  working: [0x6e, 0x8b, 0xff],
  waiting: [0xf5, 0xb5, 0x44],
  error: [0xf2, 0x55, 0x5a]
}

export const TRAY_TOOLTIP: Record<TrayStatus, string> = {
  idle: 'Qclod',
  working: 'Qclod — работает',
  waiting: 'Qclod — ждёт тебя',
  error: 'Qclod — ошибка'
}

/** What the tray shows: waiting for you beats an error, which beats work. */
export function trayStatus(tabs: TabState[]): TrayStatus {
  if (tabs.some((t) => t.status === 'waiting')) return 'waiting'
  if (tabs.some((t) => t.status === 'error')) return 'error'
  if (tabs.some((t) => t.status === 'busy' || t.status === 'starting')) return 'working'
  return 'idle'
}

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1)

/**
 * The a-orbit glyph (a one-colour mask, TRAY_GLYPH) in the given tone, with a
 * status dot at the bottom right and a 1 px clear ring around it. Raw BGRA,
 * premultiplied: Windows composites the tray icon that way.
 */
export function trayBitmap(size: 16 | 24 | 32, tone: TrayTone, status: TrayStatus): Buffer {
  const mask = Buffer.from(TRAY_GLYPH[size], 'base64')
  const pixels = Buffer.alloc(size * size * 4)
  const glyph = GLYPH_RGB[tone]
  const dot = status === 'idle' ? null : DOT_RGB[status]
  const radius = size * 0.22
  const center = size - radius - 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alpha = mask[y * size + x]! / 255
      let r = glyph[0] * alpha
      let g = glyph[1] * alpha
      let b = glyph[2] * alpha
      if (dot) {
        const d = Math.hypot(x + 0.5 - center, y + 0.5 - center)
        const keep = (1 - clamp01(radius + 1 - d + 0.5)) * (1 - clamp01(radius - d + 0.5))
        const cover = clamp01(radius - d + 0.5)
        r = r * keep + dot[0] * cover
        g = g * keep + dot[1] * cover
        b = b * keep + dot[2] * cover
        alpha = alpha * keep + cover
      }
      const at = (y * size + x) * 4
      pixels[at] = Math.round(b)
      pixels[at + 1] = Math.round(g)
      pixels[at + 2] = Math.round(r)
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

 * The Mac does not use it: see trayImageFor.
 */
function trayIcon(tone: TrayTone, status: TrayStatus): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  for (const [scaleFactor, size] of [
    [1, 16],
    [1.5, 24],
    [2, 32]
  ] as const) {
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: trayBitmap(size, tone, status) })
  }
  return image
}

/** The Mac's menu-bar mark: black with alpha, the system tints it for light and dark bars. */
export const MAC_TRAY_FILE = 'trayTemplate.png'

/**
 * The icon for a platform. A Mac gets a template image from `<resourcesDir>/tray/`
 * (the @2x neighbour is picked up by name), which carries no colour: the status is
 * the title beside it (trayTitleFor). Elsewhere the drawn bitmap with its colour dot.
 */
export function trayImageFor(
  platform: NodeJS.Platform,
  status: TrayStatus,
  resourcesDir: string,
  tone: TrayTone = 'dark'
): Electron.NativeImage {
  if (platform !== 'darwin') return trayIcon(tone, status)
  const image = nativeImage.createFromPath(join(resourcesDir, 'tray', MAC_TRAY_FILE))
  image.setTemplateImage(true)
  return image
}

/** The text next to the menu-bar mark: nothing at rest, a dot while working, «!» when it needs the person. */
export function trayTitleFor(status: TrayStatus): string {
  if (status === 'idle') return ''
  return status === 'working' ? '•' : '!'
}

/** Where the tray files are: next to the app when packaged, in the build folder in development. */
function trayResourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build')
}

export function trayMenuTemplate(
  deps: Pick<TrayDeps, 'toggleWindow' | 'onActivateTab' | 'isKeepingAwake'>,
  tabs: TabState[]
): Electron.MenuItemConstructorOptions[] {
  const awake: Electron.MenuItemConstructorOptions[] = deps.isKeepingAwake?.()
    ? [{ type: 'separator' }, { label: KEEP_AWAKE_LABEL, enabled: false }]
    : []
  return [
    { label: 'Показать Qclod', click: deps.toggleWindow },
    { type: 'separator' },
    ...(tabs.length === 0
      ? [{ label: 'Нет чатов', enabled: false } as Electron.MenuItemConstructorOptions]
      : tabs.map((tab) => ({
          label: `${tab.badge ? '• ' : ''}${tab.title}`,
          click: () => deps.onActivateTab(tab.id)
        }))),
    ...awake,
    { type: 'separator' },
    { label: 'Выйти', click: () => app.quit() }
  ]
}

export function createTray(deps: TrayDeps): Tray & { rebuild: () => void; refresh: () => void } {
  const mac = process.platform === 'darwin'
  const iconFor = (tone: TrayTone, status: TrayStatus): Electron.NativeImage =>
    trayImageFor(process.platform, status, mac ? trayResourcesDir() : '', tone)
  const tray = new Tray(iconFor(deps.getTone(), trayStatus(deps.getTabs())))
  tray.setToolTip(TRAY_TOOLTIP[trayStatus(deps.getTabs())])
  if (mac) tray.setTitle(trayTitleFor(trayStatus(deps.getTabs())))

  /** Icon and tooltip: the status or the taskbar theme changed. Skipped when neither did. */
  let shown = `${deps.getTone()}/${trayStatus(deps.getTabs())}`
  const refresh = (): void => {
    const tone = deps.getTone()
    const status = trayStatus(deps.getTabs())
    const key = `${tone}/${status}`
    if (key === shown) return
    shown = key
    tray.setImage(iconFor(tone, status))
    tray.setToolTip(TRAY_TOOLTIP[status])
    if (mac) tray.setTitle(trayTitleFor(status))
  }

  const rebuild = (): void => {
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(deps, deps.getTabs())))
  }

  rebuild()
  tray.on('click', deps.toggleWindow)

  return Object.assign(tray, { rebuild, refresh })
}
