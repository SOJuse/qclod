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
    const out = await resolver.resolve(CWD, ['src/a.ts:3:2', 'src/нет.ts'], 't1')
    expect(out).toEqual([
      { raw: 'src/a.ts:3:2', absPath: 'C:\\proj\\src\\a.ts', isDir: false, line: 3, column: 2 },
      null
    ])
    expect(resolver.knows('C:\\proj\\src\\a.ts', 't1')).toBe(true)
    expect(resolver.knows('C:\\proj\\src\\нет.ts', 't1')).toBe(false)
  })

  test('абсолютный путь с прямыми слешами и папка', async () => {
    const stat = fakeStat([], ['C:\\other\\dir'])
    const resolver = new PathResolver({ stat })
    expect(await resolver.resolve(CWD, ['C:/other/dir'], 't1')).toEqual([
      { raw: 'C:/other/dir', absPath: 'C:\\other\\dir', isDir: true }
    ])
  })

  test('повторный запрос в пределах TTL не трогает диск', async () => {
    const stat = fakeStat(['C:\\proj\\a.ts'])
    const resolver = new PathResolver({ stat })
    await resolver.resolve(CWD, ['a.ts'], 't1')
    await resolver.resolve(CWD, ['a.ts:5', 'C:\\proj\\a.ts'], 't1')
    expect(stat).toHaveBeenCalledTimes(1)
  })

  test('«нет» помнится секунду: чаще диск не трогается, созданный файл находится после', async () => {
    vi.useFakeTimers()
    try {
      const files: string[] = []
      const stat = vi.fn(async (p: string) => {
        if (files.includes(p)) return { isDirectory: () => false }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const resolver = new PathResolver({ stat })
      expect(await resolver.resolve(CWD, ['src/b.ts'], 't1')).toEqual([null])
      expect(await resolver.resolve(CWD, ['src/b.ts'], 't1')).toEqual([null])
      expect(stat).toHaveBeenCalledTimes(1)
      files.push('C:\\proj\\src\\b.ts')
      vi.advanceTimersByTime(1001)
      expect(await resolver.resolve(CWD, ['src/b.ts'], 't1')).toEqual([
        { raw: 'src/b.ts', absPath: 'C:\\proj\\src\\b.ts', isDir: false }
      ])
      expect(stat).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('после TTL путь проверяется снова', async () => {
    vi.useFakeTimers()
    try {
      const stat = fakeStat(['C:\\proj\\a.ts'])
      const resolver = new PathResolver({ stat, ttlMs: 30_000 })
      await resolver.resolve(CWD, ['a.ts'], 't1')
      vi.advanceTimersByTime(30_001)
      await resolver.resolve(CWD, ['a.ts'], 't1')
      expect(stat).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('один и тот же путь в одном вызове проверяется один раз', async () => {
    const stat = fakeStat(['C:\\proj\\a.ts'])
    const resolver = new PathResolver({ stat })
    const out = await resolver.resolve(CWD, ['a.ts', 'a.ts:2', './a.ts'], 't1')
    expect(out.every((r) => r?.absPath === 'C:\\proj\\a.ts')).toBe(true)
    expect(stat).toHaveBeenCalledTimes(1)
  })

  test('больше 200 кандидатов — лишние null без stat', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat })
    const raws = Array.from({ length: 205 }, (_, i) => `f${i}.ts`)
    const out = await resolver.resolve(CWD, raws, 't1')
    expect(out).toHaveLength(205)
    expect(out.slice(0, 200).every((r) => r !== null)).toBe(true)
    expect(out.slice(200)).toEqual([null, null, null, null, null])
    expect(stat).toHaveBeenCalledTimes(200)
    expect(stat).not.toHaveBeenCalledWith('C:\\proj\\f200.ts')
  })

  test('кэш не растёт выше maxEntries — старейшие уходят', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat, maxEntries: 3 })
    await resolver.resolve(CWD, ['a.ts', 'b.ts', 'c.ts', 'd.ts'], 't1')
    expect(resolver.knows('C:\\proj\\a.ts', 't1')).toBe(false)
    expect(resolver.knows('C:\\proj\\d.ts', 't1')).toBe(true)
    await resolver.resolve(CWD, ['a.ts'], 't1')
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
    ], 't1')
    expect(out).toEqual([null, null, null, null])
    expect(stat).not.toHaveBeenCalled()
  })

  test('относительный путь во вкладке с UNC-папкой не проверяется', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat })
    expect(await resolver.resolve('\\\\server\\share', ['a.ts'], 't1')).toEqual([null])
    expect(stat).not.toHaveBeenCalled()
  })

  test('альтернативный поток NTFS (a.txt:stream) — не путь', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat })
    expect(await resolver.resolve(CWD, ['C:\\a.exe::$DATA', 'a.txt:evil'], 't1')).toEqual([null, null])
    expect(stat).not.toHaveBeenCalled()
  })

  test('путь от текущей папки диска (C:foo) — не путь', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat })
    expect(await resolver.resolve(CWD, ['C:foo.ts', 'D:bar\\x.ts'], 't1')).toEqual([null, null])
    expect(stat).not.toHaveBeenCalled()
  })

  test.each(['CON', 'nul.txt', 'src/aux.ts', 'COM1', 'lpt9.log', 'C:\\x\\PRN', 'con .txt', 'CONIN$'])(
    'имя устройства %s не проверяется',
    async (raw) => {
      const stat = vi.fn(async () => ({ isDirectory: () => false }))
      const resolver = new PathResolver({ stat })
      expect(await resolver.resolve(CWD, [raw], 't1')).toEqual([null])
      expect(stat).not.toHaveBeenCalled()
    }
  )

  test('похожие на устройства имена остаются путями', async () => {
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const resolver = new PathResolver({ stat })
    const out = await resolver.resolve(CWD, ['console.ts', 'com10.txt', 'nullable.md'], 't1')
    expect(out.every((r) => r !== null)).toBe(true)
  })

  test('найденный в одной вкладке путь не известен другой', async () => {
    const resolver = new PathResolver({ stat: fakeStat(['C:\\proj\\a.ts']) })
    await resolver.resolve(CWD, ['a.ts'], 'tabA')
    expect(resolver.knows('C:\\proj\\a.ts', 'tabA')).toBe(true)
    expect(resolver.knows('C:\\proj\\a.ts', 'tabB')).toBe(false)
  })

  test('разрешение истекает через 30 минут и продлевается новым resolve', async () => {
    vi.useFakeTimers()
    try {
      const resolver = new PathResolver({ stat: fakeStat(['C:\\proj\\a.ts']) })
      await resolver.resolve(CWD, ['a.ts'], 't1')
      vi.advanceTimersByTime(29 * 60_000)
      await resolver.resolve(CWD, ['a.ts'], 't1')
      vi.advanceTimersByTime(29 * 60_000)
      expect(resolver.knows('C:\\proj\\a.ts', 't1')).toBe(true)
      vi.advanceTimersByTime(2 * 60_000)
      expect(resolver.knows('C:\\proj\\a.ts', 't1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test('forget убирает разрешения вкладки', async () => {
    const resolver = new PathResolver({ stat: fakeStat(['C:\\proj\\a.ts']) })
    await resolver.resolve(CWD, ['a.ts'], 't1')
    await resolver.resolve(CWD, ['a.ts'], 't2')
    resolver.forget('t1')
    expect(resolver.knows('C:\\proj\\a.ts', 't1')).toBe(false)
    expect(resolver.knows('C:\\proj\\a.ts', 't2')).toBe(true)
  })

  // PathResolver only knows Windows drive paths (win32.resolve, `C:\`); a real
  // temp dir on macOS/Linux is not one, so every answer is null there.
  test.skipIf(process.platform !== 'win32')('настоящий диск по умолчанию', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-paths-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), '')
    const resolver = new PathResolver()
    const [file, folder, missing] = await resolver.resolve(dir, ['src/a.ts', 'src', 'нет.ts'], 't1')
    expect(file).toMatchObject({ absPath: join(dir, 'src', 'a.ts'), isDir: false })
    expect(folder).toMatchObject({ absPath: join(dir, 'src'), isDir: true })
    expect(missing).toBeNull()
  })
})
