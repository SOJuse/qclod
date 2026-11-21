import { describe, expect, test } from 'vitest'
import { isAsciiPath, modelsRoot } from '@main/voice/modelsRoot'

const env = { ProgramData: 'C:\\ProgramData' } as NodeJS.ProcessEnv

describe('modelsRoot', () => {
  test('ASCII-профиль — <userData>\\models, короткий путь не спрашивается', () => {
    let asked = false
    const root = modelsRoot('C:\\Users\\ivan\\AppData\\Roaming\\Qclod', {
      platform: 'win32',
      shortPath: () => {
        asked = true
        return null
      },
      env
    })
    expect(root).toBe('C:\\Users\\ivan\\AppData\\Roaming\\Qclod\\models')
    expect(asked).toBe(false)
  })

  test('кириллица и ASCII короткий путь — короткий путь + \\models', () => {
    const asked: string[] = []
    const root = modelsRoot('C:\\Users\\Иван\\AppData\\Roaming\\Qclod', {
      platform: 'win32',
      shortPath: (p) => {
        asked.push(p)
        return 'C:\\Users\\9C5F~1\\AppData\\Roaming\\Qclod'
      },
      env
    })
    expect(asked).toEqual(['C:\\Users\\Иван\\AppData\\Roaming\\Qclod'])
    expect(root).toBe('C:\\Users\\9C5F~1\\AppData\\Roaming\\Qclod\\models')
  })

  test('кириллица без короткого пути — %ProgramData%\\Qclod\\models', () => {
    const base = { platform: 'win32', env }
    expect(modelsRoot('C:\\Users\\Иван\\Qclod', { ...base, shortPath: () => null })).toBe(
      'C:\\ProgramData\\Qclod\\models'
    )
    // 8.3 выключены: cmd отдаёт тот же длинный путь — он не годится
    expect(
      modelsRoot('C:\\Users\\Иван\\Qclod', { ...base, shortPath: (p) => p })
    ).toBe('C:\\ProgramData\\Qclod\\models')
  })

  test('не win32 — всегда <userData>/models', () => {
    expect(
      modelsRoot('/home/иван/.config/Qclod', { platform: 'linux', shortPath: () => null, env })
    ).toBe('/home/иван/.config/Qclod/models')
    expect(
      modelsRoot('/Users/ivan/Library/Application Support/Qclod', {
        platform: 'darwin',
        shortPath: () => null,
        env
      })
    ).toBe('/Users/ivan/Library/Application Support/Qclod/models')
  })
})

test('isAsciiPath', () => {
  expect(isAsciiPath('C:\\Users\\ivan\\x y')).toBe(true)
  expect(isAsciiPath('C:\\Users\\Иван')).toBe(false)
  expect(isAsciiPath('C:\\Users\\José')).toBe(false)
})
