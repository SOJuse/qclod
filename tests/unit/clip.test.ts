import { describe, expect, test } from 'vitest'
import { VIEW_CLIP, VIEW_TOTAL, clipForView, clipText } from '../../src/shared/clip'

describe('clipForView', () => {
  test('мегабайт stdout режется до VIEW_CLIP с пометкой', () => {
    const out = clipForView({ stdout: 'x'.repeat(1_000_000) }) as { stdout: string }
    expect(out.stdout.length).toBeLessThan(VIEW_CLIP + 60)
    expect(out.stdout).toContain('обрезано')
    expect(out.stdout).toContain(`${1_000_000 - VIEW_CLIP} символов`)
  })

  test('короткие строки и примитивы не меняются', () => {
    const value = { a: 'ok', n: 3, b: true, z: null, list: ['x'] }
    expect(clipForView(value)).toEqual(value)
  })

  test('свой предел символов', () => {
    expect(clipForView('abcdefghij', 4)).toBe('abcd…[обрезано: 6 символов]')
  })

  test('массивы режутся до 500 элементов', () => {
    const out = clipForView({ filenames: Array.from({ length: 2000 }, (_, i) => `f${i}`) }) as {
      filenames: string[]
    }
    expect(out.filenames).toHaveLength(500)
    expect(out.filenames[499]).toBe('f499')
  })

  test('глубже шести уровней вложенность обрезается', () => {
    let deep: unknown = 'дно'
    for (let i = 0; i < 10; i++) deep = { next: deep }
    const json = JSON.stringify(clipForView(deep))
    expect(json).not.toContain('дно')
    expect(json.length).toBeLessThan(300)
  })

  test('originalFile и base64 картинки выбрасываются', () => {
    const out = clipForView({
      filePath: 'a.ts',
      originalFile: 'x'.repeat(5000),
      file: { filePath: 'a.png', base64: 'AAAA', type: 'image/png' }
    }) as Record<string, unknown>
    expect(out).not.toHaveProperty('originalFile')
    expect(out['file']).toEqual({ filePath: 'a.png', type: 'image/png' })
    expect(out['filePath']).toBe('a.ts')
  })

  test('исходное значение не меняется', () => {
    const value = { originalFile: 'x', list: [1, 2] }
    clipForView(value)
    expect(value).toEqual({ originalFile: 'x', list: [1, 2] })
  })
})

describe('clipForView: общий бюджет', () => {
  test('большой structuredPatch не разрастается: сумма ограничена', () => {
    const hunk = { oldStart: 1, newStart: 1, lines: Array.from({ length: 500 }, () => `+${'x'.repeat(1000)}`) }
    const out = clipForView({ structuredPatch: Array.from({ length: 500 }, () => hunk) })
    expect(JSON.stringify(out).length).toBeLessThan(VIEW_TOTAL + 100_000)
    expect(JSON.stringify(out)).toContain('обрезано')
  })

  test('пустые элементы тоже стоят бюджета', () => {
    const out = clipForView({ a: Array.from({ length: 500 }, () => Array.from({ length: 500 }, () => '')) })
    expect(JSON.stringify(out).length).toBeLessThan(VIEW_TOTAL + 100_000)
  })
})

describe('clipText', () => {
  test('строка обрезается с пометкой и остаётся строкой', () => {
    const out: string = clipText('аб\nвгд', 3)
    expect(out).toBe('аб\n…[обрезано: 3 символов]')
    expect(clipText('коротко')).toBe('коротко')
    expect(clipText('x'.repeat(VIEW_CLIP + 1))).toContain('обрезано: 1')
  })
})
