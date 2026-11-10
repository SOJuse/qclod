import { describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveImageBuffer } from '@main/files/imagePaste'
import type { AppSettings } from '@shared/types'
import {
  mergeDefaults,
  sanitizeAnswer,
  sanitizeDefaults,
  sanitizeInput,
  sanitizeOverrides,
  sanitizeQuestionAnswers,
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

describe('sanitizeQuestionAnswers', () => {
  test('ответы на вопрос — только строки, короткие', () => {
    expect(sanitizeQuestionAnswers({ A: '1', B: 'x, y' })).toEqual({ A: '1', B: 'x, y' })
    // Not an object at all.
    expect(sanitizeQuestionAnswers('Справа')).toEqual({})
    expect(sanitizeQuestionAnswers(['A'])).toEqual({})
    expect(sanitizeQuestionAnswers(null)).toEqual({})
    // Values that are not strings are dropped.
    expect(sanitizeQuestionAnswers({ A: '1', B: 2, C: { x: 1 } })).toEqual({ A: '1' })
    // Which keys are real questions is the session's call, so none is lost here.
    const many = { a: '1', b: '2', c: '3', d: '4', e: '5' }
    expect(sanitizeQuestionAnswers(many)).toEqual(many)
    // An answer is a choice, not a document.
    expect(sanitizeQuestionAnswers({ A: 'я'.repeat(2001), B: 'я'.repeat(2000) })).toEqual({
      B: 'я'.repeat(2000)
    })
  })
})

describe('sanitizeDefaults', () => {
  test('bypass в умолчаниях становится default', () => {
    expect(sanitizeDefaults({ permissionMode: 'bypassPermissions', effort: 'high' })).toEqual({
      permissionMode: 'default',
      effort: 'high'
    })
  })

  test('обычные режимы и мусор — как у sanitizeOverrides', () => {
    expect(sanitizeDefaults({ permissionMode: 'plan', model: 'm', effort: 'huge', x: 1 })).toEqual({
      permissionMode: 'plan',
      model: 'm'
    })
    expect(sanitizeDefaults('не объект')).toEqual({})
  })
})

describe('mergeDefaults', () => {
  const base: AppSettings = {
    agentPath: 'claude',
    globalHotkey: 'Ctrl+Alt+Q',
    notificationsEnabled: true,
    soundEnabled: true,
    closeToTray: true,
    panelOpen: true,
    editorCommand: '',
    defaults: { permissionMode: 'acceptEdits' }
  }

  test('команда редактора — только строка', () => {
    expect(mergeDefaults(base, { editorCommand: 'code -g {path}:{line}' }).editorCommand).toBe('code -g {path}:{line}')
    expect(mergeDefaults(base, { editorCommand: 42 as never }).editorCommand).toBe('')
    expect(mergeDefaults(base, { editorCommand: 'x'.repeat(5000) }).editorCommand).toBe('')
  })

  test('выбор модели в одной вкладке становится умолчанием для новых', () => {
    const next = mergeDefaults(base, { defaults: { model: 'claude-sonnet-5' } })
    expect(next.defaults).toEqual({ permissionMode: 'acceptEdits', model: 'claude-sonnet-5' })
  })

  test('bypass не становится умолчанием, а прежнее умолчание заменяется на default', () => {
    const next = mergeDefaults(base, { defaults: { permissionMode: 'bypassPermissions' } })
    expect(next.defaults.permissionMode).toBe('default')
  })

  test('settingsSet с мусором в умолчаниях не портит остальное', () => {
    const next = mergeDefaults(base, { soundEnabled: false, defaults: { effort: 'low', extra: 1 } as never })
    expect(next.soundEnabled).toBe(false)
    expect(next.defaults).toEqual({ permissionMode: 'acceptEdits', effort: 'low' })
  })

  test('пустая строка в умолчаниях убирает ключ — «как у Claude Code»', () => {
    const withModel = mergeDefaults(base, { defaults: { model: 'claude-sonnet-5', effort: 'low' } })
    const next = mergeDefaults(withModel, { defaults: { model: '', effort: '' as never } })
    expect(next.defaults).toEqual({ permissionMode: 'acceptEdits' })
  })

  test('патч без defaults оставляет умолчания как были', () => {
    expect(mergeDefaults(base, { soundEnabled: false }).defaults).toEqual(base.defaults)
  })
})

describe('sanitizeInput: вставленные картинки', () => {
  test('миниатюра только data:image и не длиннее предела; path только из pastes', () => {
    const userData = mkdtempSync(join(tmpdir(), 'qclod-sanitize-'))
    try {
      const saved = saveImageBuffer(userData, Buffer.from([1])) as string
      const image = { kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }
      const out = sanitizeInput(
        {
          text: '',
          attachments: [
            { ...image, path: saved, thumbnail: 'data:image/png;base64,AA', width: 2000, height: 1333 },
            { ...image, path: 'C:/Windows/notepad.exe', thumbnail: 'javascript:alert(1)' },
            { ...image, thumbnail: `data:image/png;base64,${'A'.repeat(200_001)}` },
            { ...image, path: join(userData, 'pastes', '..', 'x.png'), width: -1, height: 1.5 }
          ]
        },
        userData
      )
      expect(out.attachments).toEqual([
        { ...image, path: saved, thumbnail: 'data:image/png;base64,AA', width: 2000, height: 1333 },
        image,
        image,
        image
      ])
      // Without the app's folder no path can be checked, so none passes.
      expect(sanitizeInput({ text: '', attachments: [{ ...image, path: saved }] }).attachments).toEqual([
        image
      ])
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
