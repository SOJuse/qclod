import { describe, expect, test, vi } from 'vitest'
import { appMenuTemplate } from '../../src/main/menu'

const deps = () => ({ onAction: vi.fn(), version: '1.0.0' })

describe('appMenuTemplate', () => {
  test('на Windows меню нет', () => expect(appMenuTemplate('win32', deps())).toBeNull())
  test('на Linux меню нет', () => expect(appMenuTemplate('linux', deps())).toBeNull())

  test('на Mac: Qclod, Правка, Окно; в «Правке» роли ⌘C/⌘V', () => {
    const menu = appMenuTemplate('darwin', deps())!
    expect(menu.map((m) => m.label)).toEqual(['Qclod', 'Правка', 'Окно'])
    const roles = (menu[1]!.submenu as Array<{ role?: string }>).map((i) => i.role).filter(Boolean)
    expect(roles).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  })

  test('в меню нет закрытия и перезагрузки: их клавиши наши', () => {
    const all = JSON.stringify(appMenuTemplate('darwin', deps()))
    expect(all).not.toMatch(/"role":"(close|reload|forceReload|zoomIn|zoomOut|resetZoom)"/)
  })

  test('«Настройки…» — ⌘, без своей горячей клавиши, клик зовёт onAction', () => {
    const d = deps()
    const menu = appMenuTemplate('darwin', d)!
    const item = (menu[0]!.submenu as Array<{ label?: string; accelerator?: string; registerAccelerator?: boolean; click?: () => void }>).find(
      (i) => i.label === 'Настройки…'
    )!
    expect(item.accelerator).toBe('Cmd+,')
    expect(item.registerAccelerator).toBe(false)
    item.click!()
    expect(d.onAction).toHaveBeenCalledWith('settings')
  })

  test('меню Qclod: о программе, службы, скрыть, завершить', () => {
    const roles = (appMenuTemplate('darwin', deps())![0]!.submenu as Array<{ role?: string }>)
      .map((i) => i.role)
      .filter(Boolean)
    expect(roles).toEqual(['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit'])
  })
})
