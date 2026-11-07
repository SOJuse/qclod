import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFileIndex, filterPaths } from '@main/files/fileIndex'

let root: string

function file(relative: string, contents = ''): void {
  const full = join(root, relative)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qclod-index-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('buildFileIndex', () => {
  test('пути возвращаются относительно cwd с прямыми слешами', async () => {
    file('src/app/main.ts')
    const index = await buildFileIndex(root)
    expect(index).toContain('src/app/main.ts')
    expect(index.every((p) => !p.includes('\\'))).toBe(true)
  })

  test('файлы из .gitignore не попадают в индекс', async () => {
    file('.gitignore', 'dist/\n*.log\nsecret.txt\n')
    file('src/keep.ts')
    file('dist/bundle.js')
    file('debug.log')
    file('secret.txt')

    const index = await buildFileIndex(root)
    expect(index).toContain('src/keep.ts')
    expect(index).not.toContain('dist/bundle.js')
    expect(index).not.toContain('debug.log')
    expect(index).not.toContain('secret.txt')
  })

  test('node_modules и .git пропускаются всегда', async () => {
    file('node_modules/pkg/index.js')
    file('.git/config')
    file('app.ts')
    const index = await buildFileIndex(root)
    expect(index).toEqual(['app.ts'])
  })

  test('пробелы и кириллица в пути сохраняются без искажений', async () => {
    file('Мои документы/файл 1.ts')
    const index = await buildFileIndex(root)
    expect(index).toContain('Мои документы/файл 1.ts')
  })

  test('индекс ограничен сверху и не раздувается на огромном дереве', async () => {
    for (let i = 0; i < 120; i++) file(`many/file-${i}.ts`)
    const index = await buildFileIndex(root, { limit: 50 })
    expect(index).toHaveLength(50)
  })

  test('несуществующая папка даёт пустой индекс, а не исключение', async () => {
    await expect(buildFileIndex(join(root, 'nope'))).resolves.toEqual([])
  })
})

describe('filterPaths', () => {
  const index = [
    'src/app/main.ts',
    'src/app/App.tsx',
    'src/shared/types.ts',
    'tests/unit/main.test.ts',
    'README.md'
  ]

  test('сквозной поиск находит src/app/main.ts по запросу sam', () => {
    expect(filterPaths(index, 'sam')[0]).toBe('src/app/main.ts')
  })

  test('пустой запрос возвращает начало индекса', () => {
    expect(filterPaths(index, '')).toEqual(index)
  })

  test('точное совпадение имени файла ранжируется выше', () => {
    expect(filterPaths(index, 'main.ts')[0]).toBe('src/app/main.ts')
  })

  test('регистр не важен', () => {
    expect(filterPaths(index, 'APP.TSX')).toContain('src/app/App.tsx')
  })

  test('ничего не совпало — пустой список', () => {
    expect(filterPaths(index, 'zzzzz')).toEqual([])
  })

  test('результат ограничен', () => {
    expect(filterPaths(index, 's', 2)).toHaveLength(2)
  })
})
