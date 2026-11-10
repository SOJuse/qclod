import { describe, expect, test, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathResolver } from '@main/files/pathResolver'

const CWD = 'C:\\proj'

/** A fake disk: the listed paths exist, `dirs` are folders, the rest throw ENOENT. */
function fakeStat(files: string[], dirs: string[] = []) {
  return vi.fn(async (p: string) => {
    if (dirs.includes(p)) return { isDirectory: () => true }
    if (files.includes(p)) return { isDirectory: () => false }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
}

describe('PathResolver', () => {
  test('несуществующее — null, существующее — абсолютный путь от cwd', async () => {
    const stat = fakeStat(['C:\\proj\\src\\a.ts'])
    const resolver = new PathResolver({ stat })
    const out = await resolver.resolve(CWD, ['src/a.ts:3:2', 'src/нет.ts'])
    expect(out).toEqual([
      { raw: 'src/a.ts:3:2', absPath: 'C:\\proj\\src\\a.ts', isDir: false, line: 3, column: 2 },
      null
    ])
    expect(resolver.knows('C:\\proj\\src\\a.ts')).toBe(true)
    expect(resolver.knows('C:\\proj\\src\\нет.ts')).toBe(false)
  })

  test('абсолютный путь с прямыми слешами и папка', async () => {
    const stat = fakeStat([], ['C:\\other\\dir'])
    const resolver = new PathResolver({ stat })
    expect(await resolver.resolve(CWD, ['C:/other/dir'])).toEqual([
      { raw: 'C:/other/dir', absPath: 'C:\\other\\dir', isDir: true }
    ])
  })

  test('повторный запрос в пределах TTL не трогает диск', async () => {
    const stat = fakeStat(['C:\\proj\\a.ts'])
    const resolver = new PathResolver({ stat })
    await resolver.resolve(CWD, ['a.ts'])
    await resolver.resolve(CWD, ['a.ts:5', 'C:\\proj\\a.ts'])
    expect(stat).toHaveBeenCalledTimes(1)
  })

  test('после TTL путь проверяется снова', async () => {
    vi.useFakeTimers()
    try {
      const stat = fakeStat(['C:\\proj\\a.ts'])
      const resolver = new PathResolver({ stat, ttlMs: 30_000 })
      await resolver.resolve(CWD, ['a.ts'])
      vi.advanceTimersByTime(30_001)
      await resolver.resolve(CWD, ['a.ts'])
      expect(stat).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('один и тот же путь в одном вызове проверяется один раз', async () => {
    const stat = fakeStat(['C:\\proj\\a.ts'])
    const resolver = new PathResolver({ stat })
    const out = await resolver.resolve(CWD, ['a.ts', 'a.ts:2', './a.ts'])
    expect(out.every((r) => r?.absPath === 'C:\\proj\\a.ts')).toBe(true)
    expect(stat).toHaveBeenCalledTimes(1)
  })

  test('больше 200 кандидатов — лишние null без stat', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat })
    const raws = Array.from({ length: 205 }, (_, i) => `f${i}.ts`)
    const out = await resolver.resolve(CWD, raws)
    expect(out).toHaveLength(205)
    expect(out.slice(0, 200).every((r) => r !== null)).toBe(true)
    expect(out.slice(200)).toEqual([null, null, null, null, null])
    expect(stat).toHaveBeenCalledTimes(200)
    expect(stat).not.toHaveBeenCalledWith('C:\\proj\\f200.ts')
  })

  test('кэш не растёт выше maxEntries — старейшие уходят', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat, maxEntries: 3 })
    await resolver.resolve(CWD, ['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    expect(resolver.knows('C:\\proj\\a.ts')).toBe(false)
    expect(resolver.knows('C:\\proj\\d.ts')).toBe(true)
    await resolver.resolve(CWD, ['a.ts'])
    expect(stat).toHaveBeenCalledTimes(5)
  })

  test('UNC никогда не проверяется на диске', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat })
    const out = await resolver.resolve(CWD, [
      '\\\\server\\share\\x.txt',
      '//server/share/x.txt',
      '\\\\?\\C:\\x.txt',
      '\\\\.\\pipe\\x'
    ])
    expect(out).toEqual([null, null, null, null])
    expect(stat).not.toHaveBeenCalled()
  })

  test('относительный путь во вкладке с UNC-папкой не проверяется', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat })
    expect(await resolver.resolve('\\\\server\\share', ['a.ts'])).toEqual([null])
    expect(stat).not.toHaveBeenCalled()
  })

  test('альтернативный поток NTFS (a.txt:stream) — не путь', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat })
    expect(await resolver.resolve(CWD, ['C:\\a.exe::$DATA', 'a.txt:evil'])).toEqual([null, null])
    expect(stat).not.toHaveBeenCalled()
  })

  test('настоящий диск по умолчанию', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-paths-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), '')
    const resolver = new PathResolver()
    const [file, folder, missing] = await resolver.resolve(dir, ['src/a.ts', 'src', 'нет.ts'])
    expect(file).toMatchObject({ absPath: join(dir, 'src', 'a.ts'), isDir: false })
    expect(folder).toMatchObject({ absPath: join(dir, 'src'), isDir: true })
    expect(missing).toBeNull()
  })
})
