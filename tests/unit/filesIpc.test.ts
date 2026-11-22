import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (e: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: (channel: string, fn: Handler) => handlers.set(channel, fn)
  },
  dialog: {},
  BrowserWindow: class {},
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))

import { registerAgentIpc, type AgentIpcDeps } from '@main/agentIpc'
import { PathResolver } from '@main/files/pathResolver'
import { CHANNELS } from '@shared/channels'
import { saveImageBuffer } from '@main/files/imagePaste'

type Log = Array<{ action: string; path: string; line?: number }>
const g = globalThis as { __qclodShellLog?: Log }

const CWD = realpathSync.native(mkdtempSync(join(tmpdir(), 'qclod-ipc-')))
mkdirSync(join(CWD, 'src'))
const A = join(CWD, 'src', 'a.ts')
writeFileSync(A, '')
/** The app's own folder; pasted images live in its pastes. */
const USER_DATA = realpathSync.native(mkdtempSync(join(tmpdir(), 'qclod-ud-')))
let editorCommand = ''

function setup(): void {
  handlers.clear()
  registerAgentIpc({
    getWindow: () => null,
    controller: {
      list: () => [
        { id: 't1', cwd: CWD },
        { id: 't2', cwd: CWD }
      ],
      close: async () => undefined
    },
    manager: {},
    broker: { cancelTab: () => undefined },
    rememberDefault: () => undefined,
    resolver: new PathResolver(),
    getEditorCommand: () => editorCommand,
    userData: USER_DATA
  } as unknown as AgentIpcDeps)
}

function call(channel: string, ...args: unknown[]): unknown {
  return handlers.get(channel)!({}, ...args)
}

beforeEach(() => {
  process.env['QCLOD_FAKE_SHELL'] = '1'
  g.__qclodShellLog = []
  editorCommand = ''
  setup()
})
afterEach(() => {
  delete process.env['QCLOD_FAKE_SHELL']
  delete g.__qclodShellLog
})

// Files on disk are only understood as Windows drive paths here (PathResolver, fileActions);
// a real temp dir on macOS never resolves, so these cases need the real Windows file system.
const winDisk = test.skipIf(process.platform !== 'win32')

describe('files:* каналы', () => {
  winDisk('resolve: найденное — от папки вкладки, мусор — null на своём месте', async () => {
    const out = await call(CHANNELS.filesResolve, 't1', ['src/a.ts:3', 42, 'нет.ts', 'x'.repeat(2000)])
    expect(out).toEqual([{ raw: 'src/a.ts:3', absPath: A, isDir: false, line: 3 }, null, null, null])
  })

  test('resolve: чужая вкладка и не массив', async () => {
    expect(await call(CHANNELS.filesResolve, 'нет', ['src/a.ts'])).toEqual([null])
    expect(await call(CHANNELS.filesResolve, 't1', 'src/a.ts')).toEqual([])
  })

  test('действия с путём, который main не находил, молча ничего не делают', async () => {
    expect(await call(CHANNELS.filesOpen, 't1', 'C:\\Windows\\notepad.exe')).toBeNull()
    await call(CHANNELS.filesReveal, 't1', A)
    editorCommand = 'code -g {path}:{line}'
    expect(await call(CHANNELS.filesOpenInEditor, 't1', A, 3)).toBeNull()
    expect(g.__qclodShellLog).toEqual([])
  })

  winDisk('после resolve действия работают; строка проверяется', async () => {
    await call(CHANNELS.filesResolve, 't1', ['src/a.ts'])
    expect(await call(CHANNELS.filesOpen, 't1', A)).toBe('opened')
    await call(CHANNELS.filesReveal, 't1', A)
    await call(CHANNELS.filesOpenInEditor, 't1', A, 3)
    editorCommand = 'code -g {path}:{line}'
    await call(CHANNELS.filesOpenInEditor, 't1', A, 3, 2)
    await call(CHANNELS.filesOpenInEditor, 't1', A, '3; calc')
    expect(g.__qclodShellLog).toEqual([
      { action: 'open', path: A },
      { action: 'reveal', path: A },
      { action: 'editor', path: A, line: 3 },
      { action: 'editor', path: A }
    ])
  })

  winDisk('негодный шаблон редактора возвращает объяснение', async () => {
    await call(CHANNELS.filesResolve, 't1', ['src/a.ts'])
    editorCommand = 'ed "{path}'
    expect(await call(CHANNELS.filesOpenInEditor, 't1', A)).toMatch(/кавычк/)
    expect(g.__qclodShellLog).toEqual([])
  })

  test('путь, найденный во вкладке t1, нельзя открыть из t2', async () => {
    await call(CHANNELS.filesResolve, 't1', ['src/a.ts'])
    expect(await call(CHANNELS.filesOpen, 't2', A)).toBeNull()
    await call(CHANNELS.filesReveal, 't2', A)
    expect(g.__qclodShellLog).toEqual([])
  })

  test('известный путь, но несуществующая вкладка — ничего', async () => {
    await call(CHANNELS.filesResolve, 't1', ['src/a.ts'])
    expect(await call(CHANNELS.filesOpen, 'чужая', A)).toBeNull()
    expect(g.__qclodShellLog).toEqual([])
  })

  test('после закрытия вкладки её пути больше не действуют', async () => {
    await call(CHANNELS.filesResolve, 't1', ['src/a.ts'])
    await call(CHANNELS.tabsClose, 't1')
    expect(await call(CHANNELS.filesOpen, 't1', A)).toBeNull()
  })

  winDisk('вставленную картинку из pastes можно открыть и показать без resolve, а редактор — нет', async () => {
    const pasted = saveImageBuffer(USER_DATA, Buffer.from([1])) as string
    expect(await call(CHANNELS.filesOpen, 't1', pasted)).toBe('opened')
    await call(CHANNELS.filesReveal, 't1', pasted)
    editorCommand = 'code -g {path}'
    expect(await call(CHANNELS.filesOpenInEditor, 't1', pasted)).toBeNull()
    expect(g.__qclodShellLog).toEqual([
      { action: 'open', path: pasted },
      { action: 'reveal', path: pasted }
    ])
  })

  test('исключение pastes не пускает ни соседей, ни выход через ..', async () => {
    mkdirSync(join(USER_DATA, 'pastes-x'), { recursive: true })
    const twin = join(USER_DATA, 'pastes-x', 'paste-1-deadbeef.png')
    writeFileSync(twin, '')
    expect(await call(CHANNELS.filesOpen, 't1', twin)).toBeNull()
    expect(await call(CHANNELS.filesOpen, 't1', join(USER_DATA, 'pastes', '..', 'pastes-x', 'paste-1-deadbeef.png'))).toBeNull()
    // Nor a tab that does not exist.
    const pasted = saveImageBuffer(USER_DATA, Buffer.from([1])) as string
    expect(await call(CHANNELS.filesOpen, 'чужая', pasted)).toBeNull()
    expect(g.__qclodShellLog).toEqual([])
  })
})

describe('agent:send и files:prepareImage', () => {
  test('восстановленная картинка без байт уходит с байтами своей копии; чужой путь — не уходит', async () => {
    const sent: unknown[] = []
    handlers.clear()
    registerAgentIpc({
      getWindow: () => null,
      controller: { list: () => [{ id: 't1', cwd: CWD }], send: (_id: string, input: unknown) => sent.push(input) > 0 },
      manager: {},
      broker: {},
      rememberDefault: () => undefined,
      resolver: new PathResolver(),
      getEditorCommand: () => '',
      userData: USER_DATA
    } as unknown as AgentIpcDeps)

    const pasted = saveImageBuffer(USER_DATA, Buffer.from([1, 2, 3]), 'jpg') as string
    await call(CHANNELS.agentSend, 't1', {
      text: 'вот',
      attachments: [
        { kind: 'image', mediaType: 'image/png', dataBase64: '', path: pasted },
        { kind: 'image', mediaType: 'image/png', dataBase64: '', path: A }
      ]
    })
    expect(sent).toEqual([
      {
        text: 'вот',
        attachments: [{ kind: 'image', mediaType: 'image/jpeg', dataBase64: 'AQID', path: pasted }]
      }
    ])
  })

  test('prepareImage: не строка и не картинка — понятная ошибка, а не исключение', async () => {
    expect(await call(CHANNELS.filesPrepareImage, 42, 'image/png')).toEqual({ error: 'Не похоже на картинку' })
    expect(await call(CHANNELS.filesPrepareImage, '', 'image/png')).toEqual({ error: 'Не похоже на картинку' })
    expect(await call(CHANNELS.filesPrepareImage, 'AAAA', 'image/png')).toEqual({ error: 'Не похоже на картинку' })
    // A PNG reaches nativeImage, which the electron mock lacks: a failure
    // inside is answered, not thrown.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64')
    expect(await call(CHANNELS.filesPrepareImage, png, 'image/png')).toEqual({
      error: 'Не получилось прочитать картинку'
    })
  })
})

describe('pastes: настоящий путь и типы', () => {
  winDisk('files:open открывает настоящий путь копии, а не написанный окном', async () => {
    const pasted = saveImageBuffer(USER_DATA, Buffer.from([1])) as string
    const shouted = pasted.toUpperCase().replace(/\.PNG$/, '.png')
    expect(await call(CHANNELS.filesOpen, 't1', shouted)).toBe('opened')
    expect(g.__qclodShellLog).toEqual([{ action: 'open', path: realpathSync.native(pasted) }])
  })

  test('восстановленная WebP уходит с типом image/webp', async () => {
    const sent: Array<{ attachments: unknown[] }> = []
    handlers.clear()
    registerAgentIpc({
      getWindow: () => null,
      controller: {
        list: () => [{ id: 't1', cwd: CWD }],
        send: (_id: string, input: { attachments: unknown[] }) => sent.push(input) > 0
      },
      manager: {},
      broker: {},
      rememberDefault: () => undefined,
      resolver: new PathResolver(),
      getEditorCommand: () => '',
      userData: USER_DATA
    } as unknown as AgentIpcDeps)
    const webp = saveImageBuffer(USER_DATA, Buffer.from([1, 2, 3]), 'webp') as string
    const gif = saveImageBuffer(USER_DATA, Buffer.from([1, 2, 3]), 'gif') as string
    await call(CHANNELS.agentSend, 't1', {
      text: '',
      attachments: [
        { kind: 'image', mediaType: 'image/png', dataBase64: '', path: webp },
        { kind: 'image', mediaType: 'image/png', dataBase64: '', path: gif }
      ]
    })
    expect(sent[0]!.attachments).toEqual([
      { kind: 'image', mediaType: 'image/webp', dataBase64: 'AQID', path: webp },
      { kind: 'image', mediaType: 'image/gif', dataBase64: 'AQID', path: gif }
    ])
  })
})
