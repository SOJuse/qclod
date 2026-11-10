import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
  utimesSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  cleanupPasteDir,
  isInsidePasteDir,
  pasteRealPath,
  PASTE_DIR_NAME,
  saveImageBuffer
} from '@main/files/imagePaste'

let userData: string

function pasteDir(): string {
  return join(userData, PASTE_DIR_NAME)
}

function agedFile(name: string, daysOld: number, bytes = 10): string {
  mkdirSync(pasteDir(), { recursive: true })
  const path = join(pasteDir(), name)
  writeFileSync(path, Buffer.alloc(bytes))
  const when = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000)
  utimesSync(path, when, when)
  return path
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'qclod-paste-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('saveImageBuffer', () => {
  test('изображение сохраняется как png и путь существует', () => {
    const path = saveImageBuffer(userData, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(path).not.toBeNull()
    expect(path?.endsWith('.png')).toBe(true)
    expect(existsSync(path as string)).toBe(true)
  })

  test('два изображения не перезаписывают друг друга', () => {
    const first = saveImageBuffer(userData, Buffer.from([1]))
    const second = saveImageBuffer(userData, Buffer.from([2]))
    expect(first).not.toBe(second)
    expect(readdirSync(pasteDir())).toHaveLength(2)
  })

  test('JPEG сохраняется с расширением .jpg', () => {
    const path = saveImageBuffer(userData, Buffer.from([0xff, 0xd8]), 'jpg')
    expect(path?.endsWith('.jpg')).toBe(true)
    expect(existsSync(path as string)).toBe(true)
  })

  test('пустой буфер не сохраняется', () => {
    expect(saveImageBuffer(userData, Buffer.alloc(0))).toBeNull()
  })
})

describe('cleanupPasteDir', () => {
  test('файлы старше maxAgeDays удаляются при очистке', () => {
    saveImageBuffer(userData, Buffer.from([1]))
    const old = agedFile('old.png', 10)
    const fresh = agedFile('fresh.png', 1)

    cleanupPasteDir(userData, { maxAgeDays: 7, maxBytes: 1_000_000 })

    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  test('при превышении maxBytes удаляются самые старые файлы', () => {
    const oldest = agedFile('a.png', 3, 500)
    const middle = agedFile('b.png', 2, 500)
    const newest = agedFile('c.png', 1, 500)

    cleanupPasteDir(userData, { maxAgeDays: 30, maxBytes: 1000 })

    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(middle)).toBe(true)
    expect(existsSync(newest)).toBe(true)
  })

  test('очистка не падает, если папки нет', () => {
    expect(() =>
      cleanupPasteDir(join(userData, 'nope'), { maxAgeDays: 7, maxBytes: 10 })
    ).not.toThrow()
  })

  test('в пределах лимитов ничего не удаляется', () => {
    const kept = agedFile('keep.png', 1, 100)
    cleanupPasteDir(userData, { maxAgeDays: 7, maxBytes: 1_000_000 })
    expect(existsSync(kept)).toBe(true)
  })
})

describe('isInsidePasteDir', () => {
  test('isInsidePasteDir: внутри — да, соседняя папка с похожим именем — нет', () => {
    const saved = saveImageBuffer(userData, Buffer.from([1])) as string
    expect(isInsidePasteDir(userData, saved)).toBe(true)
    // The same name in a folder whose name only starts like ours.
    const twin = join(userData, `${PASTE_DIR_NAME}-evil`)
    mkdirSync(twin, { recursive: true })
    const lookalike = join(twin, basename(saved))
    writeFileSync(lookalike, Buffer.from([1]))
    expect(isInsidePasteDir(userData, lookalike)).toBe(false)
  })

  test('путь с .. наружу, чужой файл и папка не проходят', () => {
    const saved = saveImageBuffer(userData, Buffer.from([1])) as string
    writeFileSync(join(userData, 'paste-1-deadbeef.png'), Buffer.from([1]))
    expect(isInsidePasteDir(userData, join(pasteDir(), '..', 'paste-1-deadbeef.png'))).toBe(false)
    // Something else put in the folder is not ours to open.
    writeFileSync(join(pasteDir(), 'run.exe'), Buffer.from([1]))
    expect(isInsidePasteDir(userData, join(pasteDir(), 'run.exe'))).toBe(false)
    // Neither is the folder itself, a name that is not there, or a relative path.
    expect(isInsidePasteDir(userData, pasteDir())).toBe(false)
    expect(isInsidePasteDir(userData, join(pasteDir(), 'paste-1-deadbeef.png'))).toBe(false)
    expect(isInsidePasteDir(userData, basename(saved))).toBe(false)
    // Windows paths are case-insensitive: the same file in other case is still ours.
    expect(isInsidePasteDir(userData, saved.toUpperCase().replace(/\.PNG$/, '.png'))).toBe(true)
  })
})

describe('GIF, WebP и настоящий путь', () => {
  test('GIF и WebP сохраняются со своим расширением и считаются своими', () => {
    for (const ext of ['gif', 'webp'] as const) {
      const path = saveImageBuffer(userData, Buffer.from([1]), ext) as string
      expect(path.endsWith(`.${ext}`)).toBe(true)
      expect(isInsidePasteDir(userData, path)).toBe(true)
    }
  })

  test('pasteRealPath отдаёт путь, каким он лежит на диске, а чужой — null', () => {
    const saved = saveImageBuffer(userData, Buffer.from([1])) as string
    expect(pasteRealPath(userData, saved.toUpperCase().replace(/\.PNG$/, '.png'))).toBe(realpathSync.native(saved))
    expect(pasteRealPath(userData, join(userData, 'нет.png'))).toBeNull()
  })
})
