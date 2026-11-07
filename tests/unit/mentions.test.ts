import { describe, expect, test } from 'vitest'
import { applyMention, findMentionQuery, quotePath } from '@renderer/input/mentions'

describe('findMentionQuery', () => {
  test('@ в начале строки открывает запрос', () => {
    expect(findMentionQuery('@src', 4)).toEqual({ start: 0, query: 'src' })
  })

  test('@ после пробела открывает запрос', () => {
    expect(findMentionQuery('посмотри @app', 13)).toEqual({ start: 9, query: 'app' })
  })

  test('@ без текста после него — пустой запрос', () => {
    expect(findMentionQuery('@', 1)).toEqual({ start: 0, query: '' })
  })

  test('почта не считается упоминанием', () => {
    expect(findMentionQuery('пиши на noreply', 23)).toBeNull()
  })

  test('курсор перед @ ничего не открывает', () => {
    expect(findMentionQuery('@src', 0)).toBeNull()
  })

  test('пробел после @ закрывает запрос', () => {
    expect(findMentionQuery('@src main', 9)).toBeNull()
  })

  test('без @ ничего не находится', () => {
    expect(findMentionQuery('обычный текст', 13)).toBeNull()
  })

  test('учитывается только упоминание у курсора', () => {
    expect(findMentionQuery('@first и @sec', 13)).toEqual({ start: 9, query: 'sec' })
  })
})

describe('quotePath', () => {
  test('обычный путь не трогается', () => {
    expect(quotePath('src/app/main.ts')).toBe('src/app/main.ts')
  })

  test('путь с пробелом берётся в кавычки', () => {
    // Otherwise the CLI reads it as two arguments and the mention breaks.
    expect(quotePath('Мои документы/файл 1.ts')).toBe('"Мои документы/файл 1.ts"')
  })

  test('кириллица без пробелов не требует кавычек', () => {
    expect(quotePath('исходники/главный.ts')).toBe('исходники/главный.ts')
  })

  test('кавычка внутри пути экранируется', () => {
    expect(quotePath('a "b" c.ts')).toBe('"a \\"b\\" c.ts"')
  })
})

describe('applyMention', () => {
  test('подставляет путь и ставит курсор после него', () => {
    const result = applyMention('@ap', 0, 3, 'src/app/App.tsx')
    expect(result.text).toBe('@src/app/App.tsx ')
    expect(result.caret).toBe(result.text.length)
  })

  test('сохраняет текст вокруг упоминания', () => {
    const text = 'глянь @ma и скажи'
    const result = applyMention(text, 6, 9, 'src/main.ts')
    expect(result.text).toBe('глянь @src/main.ts  и скажи')
  })

  test('путь с пробелами подставляется в кавычках', () => {
    const result = applyMention('@fa', 0, 3, 'Мои документы/файл 1.ts')
    expect(result.text).toBe('@"Мои документы/файл 1.ts" ')
  })
})
