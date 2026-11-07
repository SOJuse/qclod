import { describe, expect, test } from 'vitest'
import { sanitizeTabPatch, sanitizeOverrides } from '@main/tabs/sanitize'

describe('sanitizeTabPatch', () => {
  test('заголовок проходит', () => {
    expect(sanitizeTabPatch({ title: 'мой проект' })).toEqual({ title: 'мой проект' })
  })

  test('переопределения запуска проходят', () => {
    expect(sanitizeTabPatch({ overrides: { model: 'opus' } })).toEqual({
      overrides: { model: 'opus' }
    })
  })

  test('рабочая папка не меняется через обновление вкладки', () => {
    // Letting the renderer rewrite cwd would silently relaunch the agent
    // somewhere else; the folder is chosen once, in a dialog.
    expect(sanitizeTabPatch({ cwd: 'C:\\Windows\\System32' })).toEqual({})
  })

  test('состояние и ошибка принадлежат главному процессу', () => {
    expect(sanitizeTabPatch({ status: 'idle', error: 'нет', badge: true, id: 'other' })).toEqual({})
  })

  test('мусор вместо объекта даёт пустой патч', () => {
    expect(sanitizeTabPatch(null)).toEqual({})
    expect(sanitizeTabPatch('строка')).toEqual({})
    expect(sanitizeTabPatch([1, 2])).toEqual({})
  })

  test('слишком длинный заголовок обрезается', () => {
    const long = 'я'.repeat(500)
    expect(sanitizeTabPatch({ title: long }).title).toHaveLength(200)
  })

  test('заголовок не строка — отбрасывается', () => {
    expect(sanitizeTabPatch({ title: 42 })).toEqual({})
  })
})

describe('sanitizeOverrides', () => {
  test('известные строковые поля проходят', () => {
    expect(
      sanitizeOverrides({
        model: 'opus',
        permissionMode: 'plan',
        extraFlags: '--verbose'
      })
    ).toEqual({
      model: 'opus',
      permissionMode: 'plan',
      extraFlags: '--verbose'
    })
  })

  // mcpConfig was a v1 override; in v2 a tab cannot point the agent at another
  // MCP config, so it must fall through as an unknown field.
  test('mcpConfig больше не принимается', () => {
    expect(sanitizeOverrides({ model: 'opus', mcpConfig: './mcp.json' })).toEqual({
      model: 'opus'
    })
  })

  test('неизвестный режим разрешений отбрасывается', () => {
    expect(sanitizeOverrides({ permissionMode: 'yolo' })).toEqual({})
    expect(sanitizeOverrides({ permissionMode: 'acceptEdits' })).toEqual({
      permissionMode: 'acceptEdits'
    })
  })

  test('неизвестные поля отбрасываются', () => {
    expect(sanitizeOverrides({ model: 'opus', agentPath: 'C:\\evil.exe' })).toEqual({
      model: 'opus'
    })
  })

  test('нестроковые значения отбрасываются', () => {
    expect(sanitizeOverrides({ model: { toString: 'x' }, extraFlags: 7 })).toEqual({})
  })

  test('мусор даёт пустой объект', () => {
    expect(sanitizeOverrides(undefined)).toEqual({})
    expect(sanitizeOverrides('строка')).toEqual({})
  })
})
