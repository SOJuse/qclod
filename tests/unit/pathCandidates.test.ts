import { describe, expect, test } from 'vitest'
import { findPathCandidates, splitLineSuffix } from '@shared/pathCandidates'

describe('findPathCandidates', () => {
  test('абсолютный путь с обратными и прямыми слешами', () => {
    expect(findPathCandidates('см. C:\\proj\\src\\a.ts и C:/x/y.md').map((c) => c.path)).toEqual([
      'C:\\proj\\src\\a.ts',
      'C:/x/y.md'
    ])
  })

  test('строка и колонка на конце', () => {
    expect(findPathCandidates('src/main/index.ts:42:7,')[0]).toMatchObject({
      path: 'src/main/index.ts',
      line: 42,
      column: 7
    })
  })

  test('text — то, что стоит в тексте, со строкой; start/end указывают на него', () => {
    const text = 'правил src/a.ts:3. И всё'
    const [c] = findPathCandidates(text)
    expect(c).toMatchObject({ text: 'src/a.ts:3', path: 'src/a.ts', line: 3 })
    expect(c!.column).toBeUndefined()
    expect(text.slice(c!.start, c!.end)).toBe('src/a.ts:3')
  })

  test('путь с пробелом и кириллицей в инлайн-коде', () => {
    expect(findPathCandidates('файл `C:\\Мои проекты\\план 1.md`')[0]!.path).toBe(
      'C:\\Мои проекты\\план 1.md'
    )
  })

  test('инлайн-код даёт один кандидат на весь спан, без обрывка «C:\\Мои»', () => {
    const text = 'файл `C:\\Мои проекты\\план 1.md:12` готов'
    const found = findPathCandidates(text)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ path: 'C:\\Мои проекты\\план 1.md', line: 12 })
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe('C:\\Мои проекты\\план 1.md:12')
  })

  test('инлайн-код с командой не съедает путь внутри', () => {
    expect(findPathCandidates('запустите `node scripts/run.mjs`').map((c) => c.path)).toEqual([
      'scripts/run.mjs'
    ])
  })

  test('абсолютный путь не дублируется правилом токенов', () => {
    expect(findPathCandidates('C:\\proj\\src\\a.ts')).toHaveLength(1)
  })

  test('имя файла с расширением без слеша — кандидат', () => {
    expect(findPathCandidates('откройте README.md и package.json.').map((c) => c.path)).toEqual([
      'README.md',
      'package.json'
    ])
  })

  test('кириллическое имя файла с расширением', () => {
    expect(findPathCandidates('в план.md').map((c) => c.path)).toEqual(['план.md'])
  })

  test('скобки и кавычки не входят в путь', () => {
    expect(findPathCandidates('(см. "src/a.ts") и «docs/b.md»').map((c) => c.path)).toEqual([
      'src/a.ts',
      'docs/b.md'
    ])
  })

  test('результат упорядочен по месту в тексте', () => {
    const found = findPathCandidates('a.ts потом `C:\\x y\\b.ts` потом C:\\c.ts')
    expect(found.map((c) => c.path)).toEqual(['a.ts', 'C:\\x y\\b.ts', 'C:\\c.ts'])
    const starts = found.map((c) => c.start)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })

  test('не пути: URL, дробь, дата, версия', () => {
    expect(findPathCandidates('https://a.b/c 1/2 10.11.2026 v1.2')).toEqual([])
  })

  test('URL без пробела перед схемой и file:// — не пути', () => {
    expect(findPathCandidates('file:///C:/x.txt и ftp://h/x.txt')).toEqual([])
  })

  test('UNC и \\\\?\\ не кандидаты', () => {
    expect(findPathCandidates('\\\\server\\share\\x.txt \\\\?\\C:\\x.txt')).toEqual([])
  })

  test('UNC с прямыми слешами и в инлайн-коде — не кандидаты', () => {
    expect(findPathCandidates('//server/share/x.txt `\\\\server\\share\\a b.txt`')).toEqual([])
  })

  test('пустые сегменты — не путь', () => {
    expect(findPathCandidates('a//b.ts C:\\x\\\\y.ts')).toEqual([])
  })

  test('буква диска внутри слова — не начало пути', () => {
    expect(findPathCandidates('abC:\\x.ts')).toEqual([])
  })
})

describe('splitLineSuffix', () => {
  test('строка и колонка', () => {
    expect(splitLineSuffix('src/a.ts:3:9')).toEqual({ path: 'src/a.ts', line: 3, column: 9 })
  })
  test('только строка', () => {
    expect(splitLineSuffix('C:\\a.ts:3')).toEqual({ path: 'C:\\a.ts', line: 3 })
  })
  test('без суффикса', () => {
    expect(splitLineSuffix('C:\\a.ts')).toEqual({ path: 'C:\\a.ts' })
  })
})
