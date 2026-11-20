import { describe, expect, test } from 'vitest'
import { parseSystemUsesLightTheme } from '../../src/main/system/systemTheme'

const out = (v: string): string =>
  `\r\nHKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\r\n    SystemUsesLightTheme    REG_DWORD    ${v}\r\n\r\n`

describe('тема панели задач из реестра', () => {
  test('0x1 — светлая', () => expect(parseSystemUsesLightTheme(out('0x1'))).toBe(true))
  test('0x0 — тёмная', () => expect(parseSystemUsesLightTheme(out('0x0'))).toBe(false))
  test('иной вывод — null', () => {
    expect(parseSystemUsesLightTheme('ERROR: The system was unable to find the specified registry key')).toBeNull()
    expect(parseSystemUsesLightTheme(out('0x2'))).toBeNull()
  })
})
