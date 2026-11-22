import { describe, expect, test, vi } from 'vitest'
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

describe('запрос к реестру', () => {
  test('ключ идёт в reg с обратными слэшами', async () => {
    vi.resetModules()
    const execFile = vi.fn((_f: string, _a: string[], _o: object, cb: (e: Error | null, out: string) => void) =>
      cb(null, out('0x1'))
    )
    vi.doMock('node:child_process', () => ({ execFile }))
    const { readTaskbarLight } = await import('../../src/main/system/systemTheme')
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      expect(await readTaskbarLight()).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
      vi.doUnmock('node:child_process')
    }
    const args = execFile.mock.calls[0]![1]
    expect(args[1]).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize')
    expect(args[1]).toContain('\\')
    expect(args.slice(2)).toEqual(['/v', 'SystemUsesLightTheme'])
  })
})
