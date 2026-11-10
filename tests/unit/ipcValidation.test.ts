import { describe, expect, test } from 'vitest'
import {
  sanitizeAnswer,
  sanitizeInput,
  sanitizeOverrides,
  sanitizeTabPatch
} from '@main/tabs/sanitize'

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

describe('agentIpc: проверка полезной нагрузки', () => {
  test('ответ на разрешение по умолчанию — отказ', () => {
    expect(sanitizeAnswer(undefined)).toEqual({ behavior: 'deny' })
    expect(sanitizeAnswer({ behavior: 'что-то' })).toEqual({ behavior: 'deny' })
    expect(sanitizeAnswer({ behavior: 'allow' })).toEqual({ behavior: 'allow' })
    expect(sanitizeAnswer({ behavior: 'allow', remember: true })).toEqual({
      behavior: 'allow',
      remember: true
    })
    // Anything but a literal true is not a request to remember.
    expect(sanitizeAnswer({ behavior: 'allow', remember: 'да' })).toEqual({ behavior: 'allow' })
  })

  test('окно не может подменить ввод инструмента через updatedInput', () => {
    expect(
      sanitizeAnswer({ behavior: 'allow', updatedInput: { command: 'rm -rf /' } })
    ).toEqual({ behavior: 'allow' })
  })

  test('сообщение пользователя чистится от чужих полей', () => {
    expect(
      sanitizeInput({
        text: 'привет',
        attachments: [
          { kind: 'file', path: 'C:/проект/auth.ts' },
          { kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
          { kind: 'file' },
          { kind: 'команда', path: 'C:/evil.exe' },
          'мусор'
        ],
        tabId: 'чужое поле'
      })
    ).toEqual({
      text: 'привет',
      attachments: [
        { kind: 'file', path: 'C:/проект/auth.ts' },
        { kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }
      ]
    })
  })

  test('мусор вместо сообщения даёт пустое сообщение', () => {
    expect(sanitizeInput(null)).toEqual({ text: '', attachments: [] })
    expect(sanitizeInput('строка')).toEqual({ text: '', attachments: [] })
    expect(sanitizeInput({ attachments: 'не массив' })).toEqual({ text: '', attachments: [] })
  })
})

describe('sanitizeOverrides: усилие', () => {
  test('sanitizeOverrides пропускает только известные уровни усилия', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(sanitizeOverrides({ effort: level })).toEqual({ effort: level })
    }
    expect(sanitizeOverrides({ effort: 'ultra' })).toEqual({})
    expect(sanitizeOverrides({ effort: 3 })).toEqual({})
    expect(sanitizeOverrides({ model: 'opus', effort: 'HIGH' })).toEqual({ model: 'opus' })
  })
})
