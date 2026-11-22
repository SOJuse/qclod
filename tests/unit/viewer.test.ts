import { afterEach, describe, expect, test } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VIEWER_IMAGE_MAX, VIEWER_TEXT_MAX, languageOf, readLocal, toViewerContent } from '../../src/main/files/viewer'
import { viewerAccess, type ViewerDeps } from '../../src/main/files/viewerIpc'
import type { RelayReader } from '../../src/main/ssh/remoteFiles'
import type { TabServer } from '../../src/shared/types'
import { cleanTemps, tempDir } from './relayHarness'

afterEach(cleanTemps)

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

describe('toViewerContent', () => {
  test('NUL в первых 8 КиБ → binary', () => {
    expect(toViewerContent('/a/b.txt', Buffer.from([0x61, 0, 0x62]), 3)).toEqual({ kind: 'binary', size: 3 })
  })

  test('PNG-сигнатура → image', () => {
    const content = toViewerContent('/a/pic', PNG, PNG.length)
    expect(content).toEqual({ kind: 'image', dataUrl: `data:image/png;base64,${PNG.toString('base64')}`, size: PNG.length })
  })

  test('картинка больше 10 МБ — не картинка', () => {
    expect(toViewerContent('/a/b.png', PNG, VIEWER_IMAGE_MAX + 1)).toEqual({ kind: 'binary', size: VIEWER_IMAGE_MAX + 1 })
  })

  test('.ts → typescript; Dockerfile, без расширения', () => {
    expect(toViewerContent('/x/a.ts', Buffer.from('const a = 1'), 11)).toEqual({
      kind: 'text',
      text: 'const a = 1',
      language: 'typescript',
      size: 11,
      truncated: false
    })
    expect(languageOf('/x/Dockerfile')).toBe('dockerfile')
    expect(languageOf('C:\\x\\README')).toBe('')
  })

  test('3 МБ текста → truncated и длина ≤ 2 МБ; кириллица не рвётся', () => {
    const big = Buffer.from('я'.repeat(1_600_000), 'utf8') // 3.2 MB
    const content = toViewerContent('/x/a.txt', big, big.length)
    expect(content.kind).toBe('text')
    if (content.kind !== 'text') return
    expect(content.truncated).toBe(true)
    expect(Buffer.byteLength(content.text, 'utf8')).toBeLessThanOrEqual(VIEWER_TEXT_MAX)
    expect(content.text.endsWith('я')).toBe(true)
    expect(content.text.includes('\ufffd')).toBe(false)
  })

  test('readLocal: только абсолютный путь; папка — ошибка', async () => {
    const dir = tempDir('qclod-view-')
    writeFileSync(join(dir, 'a.py'), 'print(1)\n')
    expect(await readLocal(join(dir, 'a.py'))).toMatchObject({ kind: 'text', language: 'python', text: 'print(1)\n' })
    expect((await readLocal('a.py')).kind).toBe('error')
    expect(await readLocal(dir)).toEqual({ kind: 'error', message: 'это папка' })
  })
})

describe('viewerRead и viewerDownloadOpen', () => {
  function setup(server?: TabServer) {
    const cwd = tempDir('qclod-view-')
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export {}\n')
    const calls: Array<[string, unknown]> = []
    const client: RelayReader = {
      call: async <T,>(m: string, p: unknown): Promise<T> => {
        calls.push([m, p])
        if (m === 'fs.stat') return [{ abs: '/srv/app/src/a.ts', kind: 'file' }, null] as T
        if (m === 'fs.read') return { dataBase64: Buffer.from('remote\n').toString('base64'), size: 7, eof: true } as T
        throw new Error('нет')
      }
    }
    const opened: string[] = []
    const deps: ViewerDeps = {
      tab: (id) => (id === 't1' ? { cwd: server ? '/srv/app' : cwd, ...(server ? { server } : {}) } : undefined),
      knowsLocal: () => false,
      client: async () => client,
      userData: tempDir('qclod-ud-'),
      openPath: async (p) => {
        opened.push(p)
        return 'opened'
      }
    }
    return { cwd, calls, opened, viewer: viewerAccess(deps) }
  }

  test('local: не-абсолютный путь — error; в папке чата — текст; вне её и не из чата — error', async () => {
    const { cwd, viewer } = setup()
    expect((await viewer.read({ kind: 'local' }, 't1', 'src/a.ts')).kind).toBe('error')
    expect(await viewer.read({ kind: 'local' }, 't1', join(cwd, 'src', 'a.ts'))).toMatchObject({ kind: 'text', text: 'export {}\n' })
    expect((await viewer.read({ kind: 'local' }, 't1', join(tempDir('qclod-other-'), 'x.txt'))).kind).toBe('error')
    expect((await viewer.read({ kind: 'local' }, 'чужой', join(cwd, 'src', 'a.ts'))).kind).toBe('error')
    expect((await viewer.read({ kind: 'nope' }, 't1', join(cwd, 'src', 'a.ts'))).kind).toBe('error')
  })

  test('remote с чужим hostId — error; свой — через fs.read', async () => {
    const { viewer, calls } = setup({ hostId: 'h1' })
    expect(await viewer.read({ kind: 'remote', hostId: 'h2' }, 't1', '/srv/app/src/a.ts')).toEqual({
      kind: 'error',
      message: 'чужой сервер'
    })
    expect(calls).toEqual([])
    expect(await viewer.read({ kind: 'remote', hostId: 'h1' }, 't1', '/srv/app/src/a.ts')).toMatchObject({
      kind: 'text',
      text: 'remote\n'
    })
    // local source for a server chat — no
    expect((await viewer.read({ kind: 'local' }, 't1', '/srv/app/src/a.ts')).kind).toBe('error')
    // outside the chat's folder and never named in it — no
    expect((await viewer.read({ kind: 'remote', hostId: 'h1' }, 't1', '/etc/shadow')).kind).toBe('error')
  })

  test('filesResolve серверной вкладки → fs.stat; найденное можно читать и скачать', async () => {
    const { viewer, calls, opened } = setup({ hostId: 'h1' })
    const found = await viewer.resolveRemote('t1', '/srv/app', 'h1', ['src/a.ts:3:2', 'нет.ts'])
    expect(calls[0]).toEqual(['fs.stat', { cwd: '/srv/app', paths: ['src/a.ts', 'нет.ts'] }])
    expect(found).toEqual([{ raw: 'src/a.ts:3:2', absPath: '/srv/app/src/a.ts', isDir: false, line: 3, column: 2 }, null])
    expect(await viewer.downloadOpen('t1', '/srv/app/src/a.ts')).toBe('opened')
    expect(opened[0]!.endsWith('a.ts')).toBe(true)
    expect(await viewer.downloadOpen('t1', '/etc/shadow')).toBeNull()
  })
})
