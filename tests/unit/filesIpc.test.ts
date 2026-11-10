import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (e: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  dialog: {},
  BrowserWindow: class {},
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))

import { registerAgentIpc, type AgentIpcDeps } from '@main/agentIpc'
import { PathResolver } from '@main/files/pathResolver'
import { CHANNELS } from '@shared/channels'

type Log = Array<{ action: string; path: string; line?: number }>
const g = globalThis as { __qclodShellLog?: Log }

const CWD = realpathSync.native(mkdtempSync(join(tmpdir(), 'qclod-ipc-')))
mkdirSync(join(CWD, 'src'))
const A = join(CWD, 'src', 'a.ts')
writeFileSync(A, '')
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
    getEditorCommand: () => editorCommand
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

describe('files:* каналы', () => {
  test('resolve: найденное — от папки вкладки, мусор — null на своём месте', async () => {
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

  test('после resolve действия работают; строка проверяется', async () => {
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

  test('негодный шаблон редактора возвращает объяснение', async () => {
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
})
