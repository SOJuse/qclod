import { describe, expect, test } from 'vitest'
import { LONG_PARAGRAPH, hasLongParagraph, longFieldClasses, mostlyCyrillic, textPieces } from '@renderer/ui/longText'

describe('hasLongParagraph', () => {
  test('только абзац длиннее порога, а не весь текст', () => {
    expect(hasLongParagraph('а'.repeat(LONG_PARAGRAPH))).toBe(false)
    expect(hasLongParagraph('а'.repeat(LONG_PARAGRAPH + 1))).toBe(true)
    const lines = ('б'.repeat(100) + '\n').repeat(500)
    expect(lines.length).toBeGreaterThan(LONG_PARAGRAPH)
    expect(hasLongParagraph(lines)).toBe(false)
    expect(hasLongParagraph(lines + 'в'.repeat(LONG_PARAGRAPH + 1))).toBe(true)
    expect(hasLongParagraph('')).toBe(false)
  })
})

describe('textPieces', () => {
  const paragraph = (n: number): string => {
    let s = ''
    for (let i = 0; s.length < n; i++) s += ['окно', 'зависло,', 'React', '—', 'текст'][i % 5] + ' '
    return s.slice(0, n)
  }

  test('куски складываются ровно в исходный текст', () => {
    for (const text of [paragraph(200_000), 'а'.repeat(50_001), paragraph(10) , '', 'x\n'.repeat(3000)]) {
      expect(textPieces(text, 2000).join('')).toBe(text)
    }
  })

  test('короткий текст — один кусок', () => {
    expect(textPieces('привет мир', 2000)).toEqual(['привет мир'])
  })

  test('режет после пробела, куски не длиннее предела с небольшим запасом', () => {
    const pieces = textPieces(paragraph(200_000), 2000)
    expect(pieces.length).toBeGreaterThan(50)
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.length).toBeLessThanOrEqual(2000)
      expect(piece.length).toBeGreaterThan(1500)
      expect(piece.endsWith(' ')).toBe(true)
    }
  })

  test('без пробелов режет по размеру, но не внутри суррогатной пары и не перед знаком ударения', () => {
    const emoji = '😀'.repeat(3000) // each is two UTF-16 units
    for (const piece of textPieces(emoji, 2001)) {
      expect(/^[\uDC00-\uDFFF]/.test(piece)).toBe(false)
      expect(/[\uD800-\uDBFF]$/.test(piece)).toBe(false)
    }
    const stressed = 'а\u0301'.repeat(3000)
    const pieces = textPieces(stressed, 2001)
    expect(pieces.join('')).toBe(stressed)
    for (const piece of pieces) expect(piece.startsWith('\u0301')).toBe(false)
  })
})

describe('mostlyCyrillic', () => {
  test('кириллицы больше, чем латиницы', () => {
    expect(mostlyCyrillic('окно зависло после React и src/main')).toBe(true)
    expect(mostlyCyrillic('the window froze on привет')).toBe(false)
    expect(mostlyCyrillic('123 — ...')).toBe(false)
    expect(mostlyCyrillic('')).toBe(false)
  })
})

describe('longFieldClasses', () => {
  test('обычный текст — без классов; длинный абзац — без переноса; русский — ещё и кириллический файл шрифта', () => {
    expect(longFieldClasses('привет')).toEqual([])
    expect(longFieldClasses('привет '.repeat(2000))).toEqual(['is-long', 'is-cyrillic'])
    expect(longFieldClasses('hello '.repeat(2000))).toEqual(['is-long'])
    expect(longFieldClasses('привет\n'.repeat(2000))).toEqual([])
  })
})
