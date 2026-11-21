import { describe, expect, test } from 'vitest'
import { splitPathLine } from '@renderer/paths/pathLine'

describe('splitPathLine', () => {
  test('строка и столбец', () => {
    expect(splitPathLine('src/a.ts:3')).toEqual({ path: 'src/a.ts', line: 3 })
    expect(splitPathLine('src/a.ts:3:7')).toEqual({ path: 'src/a.ts', line: 3 })
  })

  test('двоеточие диска — не строка', () => {
    expect(splitPathLine('C:\\x\\a.ts')).toEqual({ path: 'C:\\x\\a.ts' })
    expect(splitPathLine('C:\\x\\a.ts:12')).toEqual({ path: 'C:\\x\\a.ts', line: 12 })
  })

  test('нулевая и нечисловая «строка» — без строки', () => {
    expect(splitPathLine('a.ts:0').line).toBeUndefined()
    expect(splitPathLine('a.ts:x').line).toBeUndefined()
    expect(splitPathLine('a.ts').line).toBeUndefined()
  })
})
