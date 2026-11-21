import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHANNELS } from '@shared/channels'
import { registerViewerReadIpc, readForViewerLocal, VIEWER_MAX_BYTES } from '@main/files/viewerRead'

type Handler = (e: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }
}))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'qclod-view-')))
  dirs.push(d)
  return d
}

describe('чтение для просмотра', () => {
  test('текст, двоичный, пропавший, большой', () => {
    const d = tmp()
    writeFileSync(join(d, 'a.txt'), 'привет\n')
    writeFileSync(join(d, 'b.bin'), Buffer.from([1, 2, 0, 3]))
    writeFileSync(join(d, 'big.txt'), 'x'.repeat(VIEWER_MAX_BYTES + 10))
    expect(readForViewerLocal(join(d, 'a.txt'))).toMatchObject({ kind: 'text', text: 'привет\n', truncated: false })
    expect(readForViewerLocal(join(d, 'b.bin'))).toMatchObject({ kind: 'binary' })
    expect(readForViewerLocal(join(d, 'none.txt'))).toEqual({ kind: 'missing' })
    expect(readForViewerLocal(join(d, 'big.txt'))).toMatchObject({ kind: 'text', truncated: true })
    expect(readForViewerLocal(d)).toMatchObject({ kind: 'error' })
  })

  test('читает только файл вкладки или найденный в её тексте', () => {
    const project = tmp()
    const other = tmp()
    mkdirSync(join(project, 'src'))
    writeFileSync(join(project, 'src', 'a.ts'), 'a\n')
    writeFileSync(join(other, 'secret.txt'), 'secret\n')
    const known = new Set<string>()
    registerViewerReadIpc({ tabs: () => [{ id: 't', cwd: project }], knows: (p, id) => id === 't' && known.has(p) })
    const read = (tab: unknown, path: unknown): unknown => handlers.get(CHANNELS.filesViewerRead)!({}, tab, path)

    expect(read('t', join(project, 'src', 'a.ts'))).toMatchObject({ kind: 'text', text: 'a\n' })
    expect(read('t', join(other, 'secret.txt'))).toMatchObject({ kind: 'error' })
    expect(read('zzz', join(project, 'src', 'a.ts'))).toMatchObject({ kind: 'error' })
    expect(read('t', 'src/a.ts')).toMatchObject({ kind: 'error' })
    expect(read('t', 42)).toMatchObject({ kind: 'error' })
    expect(read('t', join(project, '..', 'x', '..', 'nothing.txt'))).toMatchObject({ kind: 'missing' })

    known.add(join(other, 'secret.txt'))
    expect(read('t', join(other, 'secret.txt'))).toMatchObject({ kind: 'text' })

    // A link out of the folder is not «inside» it.
    try {
      symlinkSync(join(other, 'secret.txt'), join(project, 'link.txt'))
    } catch {
      return // no symlink right on this machine
    }
    known.clear()
    expect(read('t', join(project, 'link.txt'))).toMatchObject({ kind: 'error' })
  })
})
