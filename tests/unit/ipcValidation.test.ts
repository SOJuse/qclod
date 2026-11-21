import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveImageBuffer } from '@main/files/imagePaste'
import { DEFAULT_LAYOUT, type AppSettings } from '@shared/types'
import { CHANNELS } from '@shared/channels'
import { registerAgentIpc, type AgentIpcDeps } from '@main/agentIpc'
import { LayoutStore } from '@main/store/layoutStore'
import {
  mergeDefaults,
  sanitizeAnswer,
  sanitizeDefaults,
  sanitizeInput,
  sanitizeLayoutPatch,
  sanitizeOverrides,
  sanitizePlanDecision,
  sanitizeQuestionAnswers,
  sanitizeQuestionNotes,
  sanitizeSettingsFields,
  sanitizeTabPatch
} from '@main/tabs/sanitize'

type Handler = (e: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  dialog: {},
  BrowserWindow: class {},
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() }
}))

describe('sanitizeTabPatch', () => {
  test('tabs:update не даёт окну подменить remote', () => {
    expect(sanitizeTabPatch({ remote: { state: 'on', url: 'https://x' }, title: 'a' })).toEqual({
      title: 'a'
    })
  })

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

  test('«до конца сессии» и причина отказа проходят, только в своём виде', () => {
    expect(sanitizeAnswer({ behavior: 'allow', forSession: true })).toEqual({
      behavior: 'allow',
      forSession: true
    })
    // Anything but a literal true is not a request; a deny is never «for the session».
    expect(sanitizeAnswer({ behavior: 'allow', forSession: 'да' })).toEqual({ behavior: 'allow' })
    expect(sanitizeAnswer({ behavior: 'deny', forSession: true })).toEqual({ behavior: 'deny' })

    expect(sanitizeAnswer({ behavior: 'deny', message: 'не трогай main' })).toEqual({
      behavior: 'deny',
      message: 'не трогай main'
    })
    expect(sanitizeAnswer({ behavior: 'deny', message: 'п'.repeat(2000) })).toEqual({
      behavior: 'deny',
      message: 'п'.repeat(2000)
    })
    // Trimmed; then too long, empty, not a string, or on an allow: no message at all.
    expect(sanitizeAnswer({ behavior: 'deny', message: '  не трогай main \n' })).toEqual({
      behavior: 'deny',
      message: 'не трогай main'
    })
    expect(sanitizeAnswer({ behavior: 'deny', message: ` ${'п'.repeat(2000)} ` })).toEqual({
      behavior: 'deny',
      message: 'п'.repeat(2000)
    })
    expect(sanitizeAnswer({ behavior: 'deny', message: 'п'.repeat(2001) })).toEqual({ behavior: 'deny' })
    expect(sanitizeAnswer({ behavior: 'deny', message: '' })).toEqual({ behavior: 'deny' })
    expect(sanitizeAnswer({ behavior: 'deny', message: '   \n ' })).toEqual({ behavior: 'deny' })
    expect(sanitizeAnswer({ behavior: 'deny', message: 42 })).toEqual({ behavior: 'deny' })
    expect(sanitizeAnswer({ behavior: 'allow', message: 'ок' })).toEqual({ behavior: 'allow' })
  })

  test('«до конца сессии» сильнее «всегда»: узкий ответ не становится правилом навсегда', () => {
    expect(sanitizeAnswer({ behavior: 'allow', remember: true, forSession: true })).toEqual({
      behavior: 'allow',
      forSession: true
    })
    // A deny is never «for the session», so remember stays as it always did.
    expect(sanitizeAnswer({ behavior: 'deny', remember: true, forSession: true })).toEqual({
      behavior: 'deny',
      remember: true
    })
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

  test('не больше 64 ответов, и вопрос не длиннее 2000 знаков', () => {
    const lots = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`q${i}`, 'да']))
    expect(Object.keys(sanitizeQuestionAnswers(lots))).toHaveLength(64)
    expect(sanitizeQuestionAnswers({ ['в'.repeat(2001)]: 'да', ['в'.repeat(2000)]: 'нет' })).toEqual({
      ['в'.repeat(2000)]: 'нет'
    })
  })
})

describe('sanitizeQuestionNotes', () => {
  test('комментарии к ответам — только строки до 2000 знаков, не больше 64', () => {
    expect(sanitizeQuestionNotes({ 'Где?': 'ближе к краю' })).toEqual({ 'Где?': 'ближе к краю' })
    for (const garbage of [null, undefined, 'строка', ['A'], 5]) {
      expect(sanitizeQuestionNotes(garbage)).toEqual({})
    }
    expect(sanitizeQuestionNotes({ A: 'да', B: 2, C: { x: 1 }, D: '', E: '  \n ' })).toEqual({ A: 'да' })
    expect(sanitizeQuestionNotes({ A: '  у окна \n' })).toEqual({ A: 'у окна' })
    expect(sanitizeQuestionNotes({ A: ` ${'я'.repeat(2000)} ` })).toEqual({ A: 'я'.repeat(2000) })
    expect(sanitizeQuestionNotes({ A: 'я'.repeat(2001), B: 'я'.repeat(2000) })).toEqual({
      B: 'я'.repeat(2000)
    })
    expect(sanitizeQuestionNotes({ ['в'.repeat(2001)]: 'да', ['в'.repeat(2000)]: 'нет' })).toEqual({
      ['в'.repeat(2000)]: 'нет'
    })
    const lots = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`q${i}`, 'да']))
    expect(Object.keys(sanitizeQuestionNotes(lots))).toHaveLength(64)
  })
})

describe('sanitizePlanDecision', () => {
  test('одобрение — только буквальное true; не объект — не ответ', () => {
    expect(sanitizePlanDecision({ approve: true })).toEqual({ approve: true })
    expect(sanitizePlanDecision({ approve: false })).toEqual({ approve: false })
    expect(sanitizePlanDecision({ approve: 'да' })).toEqual({ approve: false })
    expect(sanitizePlanDecision({ approve: 'true' })).toEqual({ approve: false })
    for (const garbage of [null, undefined, true, 'approve', [true]]) {
      expect(sanitizePlanDecision(garbage)).toBeNull()
    }
  })

  test('комментарий обрезается по краям, до 4000 знаков; пустой или длиннее — его нет', () => {
    expect(sanitizePlanDecision({ approve: false, comment: '  без миграций \n', extra: 1 })).toEqual({
      approve: false,
      comment: 'без миграций'
    })
    expect(sanitizePlanDecision({ approve: true, comment: ` ${'к'.repeat(4000)} ` })?.comment).toHaveLength(4000)
    expect(sanitizePlanDecision({ approve: true, comment: 'к'.repeat(4001) })).toEqual({ approve: true })
    expect(sanitizePlanDecision({ approve: true, comment: '   ' })).toEqual({ approve: true })
    expect(sanitizePlanDecision({ approve: true, comment: 3 })).toEqual({ approve: true })
  })

  test('правленый план — только при одобрении; негодный план делает всё решение негодным', () => {
    expect(sanitizePlanDecision({ approve: true, plan: '1. шаг' })).toEqual({ approve: true, plan: '1. шаг' })
    expect(sanitizePlanDecision({ approve: true, plan: 'п'.repeat(100_000) })?.plan).toHaveLength(100_000)
    // A rejection carries no plan to carry out.
    expect(sanitizePlanDecision({ approve: false, plan: '1. шаг' })).toEqual({ approve: false })
    // Never cut, never dropped quietly: the agent must not run the plan the user had changed.
    for (const plan of ['п'.repeat(100_001), 'п'.repeat(200_000), '', '  \n ', 42, { text: 'x' }, null]) {
      expect(sanitizePlanDecision({ approve: true, plan })).toBeNull()
    }
    expect(sanitizePlanDecision({ approve: false, plan: 'п'.repeat(100_001) })).toBeNull()
  })
})

describe('sanitizeLayoutPatch', () => {
  test('панели — строки до 200 знаков, без повторов, не больше 4', () => {
    expect(sanitizeLayoutPatch({ panes: ['a', 'a', 1, 'b', 'c', 'd', 'e'] })).toEqual({
      panes: ['a', 'b', 'c', 'd']
    })
    expect(sanitizeLayoutPatch({ panes: ['', 'x'.repeat(201), 'x'.repeat(200)] })).toEqual({
      panes: ['x'.repeat(200)]
    })
    expect(sanitizeLayoutPatch({ panes: [] })).toEqual({ panes: [] })
    expect(sanitizeLayoutPatch({ panes: 'a' })).toEqual({})
  })

  test('ширины — конечные числа больше нуля, не больше 4', () => {
    expect(sanitizeLayoutPatch({ paneWidths: [NaN, -1, 0.5] })).toEqual({ paneWidths: [0.5] })
    expect(sanitizeLayoutPatch({ paneWidths: [Infinity, 0, '1', 1, 2, 3, 4, 5] })).toEqual({
      paneWidths: [1, 2, 3, 4]
    })
    expect(sanitizeLayoutPatch({ paneWidths: 0.5 })).toEqual({})
  })

  test('projectCollapsed без строки cwd отброшен', () => {
    expect(sanitizeLayoutPatch({ projectCollapsed: { cwd: 1, collapsed: true } })).toEqual({})
    expect(sanitizeLayoutPatch({ projectCollapsed: { collapsed: true } })).toEqual({})
    expect(sanitizeLayoutPatch({ projectCollapsed: { cwd: '', collapsed: true } })).toEqual({})
    expect(sanitizeLayoutPatch({ projectCollapsed: { cwd: 'C:\\p', collapsed: 'да' } })).toEqual({})
    expect(sanitizeLayoutPatch({ projectCollapsed: 'C:\\p' })).toEqual({})
    // Stage 6 (task 22): a server's project folds by its hostId (≤ 200); anything else is dropped.
    expect(sanitizeLayoutPatch({ projectCollapsed: { cwd: 'C:\\p', collapsed: true, hostId: 'x' } })).toEqual({
      projectCollapsed: { cwd: 'C:\\p', collapsed: true, hostId: 'x' }
    })
    expect(sanitizeLayoutPatch({ projectCollapsed: { cwd: '/p', collapsed: true, hostId: 'x'.repeat(201) } })).toEqual({
      projectCollapsed: { cwd: '/p', collapsed: true }
    })
    expect(sanitizeLayoutPatch({ projectCollapsed: { cwd: '/p', collapsed: true, hostId: 7 } })).toEqual({
      projectCollapsed: { cwd: '/p', collapsed: true }
    })
  })

  test('боковая панель — только boolean; чужие ключи и мусор отброшены', () => {
    expect(sanitizeLayoutPatch({ sidebarCollapsed: true, active: 'a', projects: [] })).toEqual({
      sidebarCollapsed: true
    })
    expect(sanitizeLayoutPatch({ sidebarCollapsed: 'yes' })).toEqual({})
    for (const garbage of [null, undefined, 5, 'x', [1]]) expect(sanitizeLayoutPatch(garbage)).toEqual({})
  })
})

describe('этап 2: обработчики-заглушки в main', () => {
  const plans: Array<[string, unknown]> = []
  const questions: Array<[string, Record<string, string>, Record<string, string> | undefined]> = []

  const layoutDirs: string[] = []
  afterEach(() => {
    for (const dir of layoutDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function register(): void {
    handlers.clear()
    const layoutDir = mkdtempSync(join(tmpdir(), 'qclod-ipc-layout-'))
    layoutDirs.push(layoutDir)
    plans.length = 0
    questions.length = 0
    const session = {
      answerPlan: async (requestId: string, decision: unknown) => {
        plans.push([requestId, decision])
      },
      answerQuestion: (
        toolUseId: string,
        answers: Record<string, string>,
        notes?: Record<string, string>
      ) => {
        questions.push([toolUseId, answers, notes])
      }
    }
    registerAgentIpc({
      getWindow: () => null,
      controller: { list: () => [], setPanes: async () => undefined },
      manager: { get: (id: string) => (id === 't1' ? session : undefined) },
      broker: { cancelTab: () => undefined },
      layout: new LayoutStore(layoutDir, () => undefined),
      history: { list: async () => [] },
      rememberDefault: () => undefined,
      resolver: { forget: () => undefined },
      getEditorCommand: () => '',
      userData: tmpdir()
    } as unknown as AgentIpcDeps)
  }

  const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({}, ...args)

  test('plan:answer передаёт сессии проверенное решение целиком', async () => {
    register()
    await call(CHANNELS.planAnswer, 't1', 'p1', { approve: true, comment: ' ок ', plan: '1. шаг', extra: 1 })
    await call(CHANNELS.planAnswer, 't1', 'p2', { approve: false, comment: 'сначала тесты', plan: '1. шаг' })
    await call(CHANNELS.planAnswer, 't1', 'p3', { approve: 'да' })
    await call(CHANNELS.planAnswer, 't1', 5, { approve: true })
    expect(plans).toEqual([
      ['p1', { approve: true, comment: 'ок', plan: '1. шаг' }],
      ['p2', { approve: false, comment: 'сначала тесты' }],
      ['p3', { approve: false }]
    ])
  })

  test('plan:answer с негодным решением ничего не отвечает — карточка остаётся открытой', async () => {
    register()
    await call(CHANNELS.planAnswer, 't1', 'p1', { approve: true, plan: 'п'.repeat(100_001) })
    await call(CHANNELS.planAnswer, 't1', 'p2', { approve: true, plan: '   ' })
    await call(CHANNELS.planAnswer, 't1', 'p3', true)
    expect(plans).toEqual([])
  })

  test('question:answer передаёт сессии проверенные комментарии четвёртым аргументом', async () => {
    register()
    await call(CHANNELS.questionAnswer, 't1', 'q1', { 'Где?': 'Справа' }, { 'Где?': '  у окна ', B: 2 })
    await call(CHANNELS.questionAnswer, 't1', 'q2', { 'Где?': 'Слева' })
    await call(CHANNELS.questionAnswer, 't1', 'q3', { 'Где?': 'Слева' }, 'мусор')
    expect(questions).toEqual([
      ['q1', { 'Где?': 'Справа' }, { 'Где?': 'у окна' }],
      ['q2', { 'Где?': 'Слева' }, {}],
      ['q3', { 'Где?': 'Слева' }, {}]
    ])
  })

  test('раскладка и проекты: пустая раскладка и неизвестные папки — значения по умолчанию', async () => {
    register()
    expect(await call(CHANNELS.layoutGet)).toEqual(DEFAULT_LAYOUT)
    expect(await call(CHANNELS.projectForget, 'C:\\p')).toEqual(DEFAULT_LAYOUT)
    expect(await call(CHANNELS.projectHistory, 'C:\\p')).toEqual([])
    expect(await call(CHANNELS.projectOpenSession, 'C:\\p', 's1')).toBeNull()
    // этап 6: a folder on another machine comes with its hostId, last.
    expect(await call(CHANNELS.projectHistory, '/home/u/p', 'srv1')).toEqual([])
    expect(await call(CHANNELS.projectOpenSession, '/home/u/p', 's1', undefined, 'srv1')).toBeNull()
    expect(await call(CHANNELS.projectForget, '/home/u/p', 'srv1')).toEqual(DEFAULT_LAYOUT)
    expect(await call(CHANNELS.layoutSet, { sidebarCollapsed: true })).toEqual({
      ...DEFAULT_LAYOUT,
      sidebarCollapsed: true
    })
    expect(DEFAULT_LAYOUT).toEqual({
      panes: [],
      active: null,
      paneWidths: [],
      sidebarCollapsed: false,
      projects: []
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
    autoAnswerMinutes: 5,
    openAtLogin: true,
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

  test('settingsSet: неизвестные ключи и чужие типы не сохраняются', () => {
    const next = mergeDefaults(base, {
      agentPath: 42,
      globalHotkey: { a: 1 },
      closeToTray: 'да',
      panelOpen: 1,
      notificationsEnabled: false,
      evil: 'x'
    } as never)
    expect(next).toEqual({ ...base, notificationsEnabled: false })
    expect('evil' in next).toBe(false)
  })

  test('settingsSet: путь к агенту — строка разумной длины без нулевого байта', () => {
    expect(mergeDefaults(base, { agentPath: 'C:\\tools\\claude.exe' }).agentPath).toBe('C:\\tools\\claude.exe')
    expect(mergeDefaults(base, { agentPath: 'a'.repeat(5000) }).agentPath).toBe(base.agentPath)
    expect(mergeDefaults(base, { agentPath: 'claude\0.exe' }).agentPath).toBe(base.agentPath)
  })

  test('settingsSet: мусор вместо объекта ничего не меняет', () => {
    expect(mergeDefaults(base, null as never)).toEqual(base)
    expect(mergeDefaults(base, 'строка' as never)).toEqual(base)
  })
})

describe('sanitizeSettingsFields', () => {
  test('оставляет только известные поля своего типа', () => {
    expect(
      sanitizeSettingsFields({
        agentPath: 'claude',
        globalHotkey: 'Control+Shift+Space',
        soundEnabled: true,
        defaults: { model: 'x' },
        editorCommand: 'code -g {path}',
        junk: true
      })
    ).toEqual({ agentPath: 'claude', globalHotkey: 'Control+Shift+Space', soundEnabled: true })
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

describe('sanitizeErrorReport', () => {
  test('garbage gives null', async () => {
    const { sanitizeErrorReport } = await import('@main/tabs/sanitize')
    for (const v of [null, undefined, 5, 'x', [], {}, { scope: 'nope', message: 'm' }, { scope: 'app' }, { scope: 'app', message: 3 }]) {
      expect(sanitizeErrorReport(v)).toBeNull()
    }
  })

  test('a good report passes and long strings are cut to 20 000', async () => {
    const { sanitizeErrorReport } = await import('@main/tabs/sanitize')
    const long = 'a'.repeat(30000)
    const cut = 'a'.repeat(20000)
    const r = sanitizeErrorReport({ scope: 'pane', message: long, stack: long, componentStack: long, extra: 1 })
    expect(r).toEqual({ scope: 'pane', message: cut, stack: cut, componentStack: cut })
    expect(sanitizeErrorReport({ scope: 'window', message: 'm', stack: 4 })).toEqual({ scope: 'window', message: 'm' })
  })
})
