import { describe, expect, test } from 'vitest'
import { linkify, pathTexts, relativePath } from '@renderer/paths/linkify'
import type { ResolvedPath } from '@shared/types'

const target: ResolvedPath = { raw: 'src/a.ts:3', absPath: 'C:\\p\\src\\a.ts', isDir: false, line: 3 }

describe('linkify', () => {
  test('известный путь становится ссылкой, остальное — текстом', () => {
    expect(linkify('правил src/a.ts:3 и b', new Map([['src/a.ts:3', target]]))).toEqual([
      'правил ',
      { text: 'src/a.ts:3', target },
      ' и b'
    ])
  })

  test('путь, которого нет на диске, остаётся текстом', () => {
    expect(linkify('Посмотрите src/a.ts:3 и src/нет.ts', new Map([['src/a.ts:3', target]]))).toEqual([
      'Посмотрите ',
      { text: 'src/a.ts:3', target },
      ' и src/нет.ts'
    ])
  })

  test('без известных путей — один кусок текста; пустой текст — ничего', () => {
    expect(linkify('просто src/a.ts', new Map())).toEqual(['просто src/a.ts'])
    expect(linkify('', new Map([['src/a.ts:3', target]]))).toEqual([])
  })

  test('путь в начале и в конце строки, точка после пути — текст', () => {
    const t: ResolvedPath = { raw: 'README.md', absPath: 'C:\\p\\README.md', isDir: false }
    expect(linkify('README.md и README.md.', new Map([['README.md', t]]))).toEqual([
      { text: 'README.md', target: t },
      ' и ',
      { text: 'README.md', target: t },
      '.'
    ])
  })

  test('инлайн-код с пробелами берётся целиком', () => {
    const t: ResolvedPath = { raw: 'C:\\Мои проекты\\план 1.md', absPath: 'C:\\Мои проекты\\план 1.md', isDir: false }
    expect(linkify('C:\\Мои проекты\\план 1.md', new Map([[t.raw, t]]), true)).toEqual([{ text: t.raw, target: t }])
    // The same text outside code is cut at the first space.
    expect(linkify('C:\\Мои проекты\\план 1.md', new Map([[t.raw, t]]))).toEqual(['C:\\Мои проекты\\план 1.md'])
  })
})

describe('pathTexts', () => {
  test('что спросить у main: тексты кандидатов без повторов', () => {
    expect(pathTexts('src/a.ts:3, src/a.ts:3 и http://x.ru/a.ts')).toEqual(['src/a.ts:3'])
    expect(pathTexts('C:\\a b\\c.md', true)).toEqual(['C:\\a b\\c.md'])
    expect(pathTexts('обычный текст')).toEqual([])
  })
})

describe('relativePath', () => {
  test('от папки вкладки, через обратную косую', () => {
    expect(relativePath('C:\\p', 'C:\\p\\src\\a.ts')).toBe('src\\a.ts')
    expect(relativePath('C:/p/', 'C:\\p\\src\\a.ts')).toBe('src\\a.ts')
  })
  test('регистр букв в Windows не важен', () => {
    expect(relativePath('c:\\P', 'C:\\p\\a.ts')).toBe('a.ts')
  })
  test('вне папки — через «..»; сама папка — «.»', () => {
    expect(relativePath('C:\\p\\sub', 'C:\\p\\a.ts')).toBe('..\\a.ts')
    expect(relativePath('C:\\p', 'C:\\p')).toBe('.')
  })
  test('другой диск или нет папки — полный путь', () => {
    expect(relativePath('D:\\p', 'C:\\p\\a.ts')).toBe('C:\\p\\a.ts')
    expect(relativePath('', 'C:\\p\\a.ts')).toBe('C:\\p\\a.ts')
  })
})
