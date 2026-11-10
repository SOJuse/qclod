import { describe, expect, test } from 'vitest'
import {
  applyMention,
  clipboardHasImage,
  dropTextFor,
  findMentionQuery,
  formatPathsForInput,
  quotePath
} from '@renderer/input/mentions'

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
    expect(findMentionQuery('пиши на name@example.com', 24)).toBeNull()
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

describe('formatPathsForInput', () => {
  test('один путь подставляется как @путь', () => {
    expect(formatPathsForInput(['C:/проекты/app.ts'])).toBe('@C:/проекты/app.ts')
  })

  test('несколько путей разделяются пробелом', () => {
    expect(formatPathsForInput(['a.ts', 'b.ts'])).toBe('@a.ts @b.ts')
  })

  test('путь с пробелами не разваливается по пробелу', () => {
    // Review Focus 2: dropping a file from "Мои проекты" must still read as one path.
    expect(formatPathsForInput(['C:/Мои проекты/файл 1.ts'])).toBe(
      '@"C:/Мои проекты/файл 1.ts"'
    )
  })

  test('пустой список даёт пустую строку', () => {
    expect(formatPathsForInput([])).toBe('')
  })
})

describe('dropTextFor', () => {
  const file = (name: string): File => ({ name }) as File

  test('складывает пути всех перетащенных файлов', () => {
    const resolve = (f: File): string => `C:/проекты/${f.name}`
    expect(dropTextFor([file('a.ts'), file('b.ts')], resolve)).toBe(
      '@C:/проекты/a.ts @C:/проекты/b.ts '
    )
  })

  test('файлы без пути пропускаются', () => {
    const resolve = (f: File): string | null => (f.name === 'ok.ts' ? 'C:/ok.ts' : null)
    expect(dropTextFor([file('ok.ts'), file('нет.ts')], resolve)).toBe('@C:/ok.ts ')
  })

  test('ничего не разрешилось — пустая строка, вставлять нечего', () => {
    expect(dropTextFor([file('x')], () => null)).toBe('')
  })

  test('путь с пробелами остаётся одним токеном', () => {
    expect(dropTextFor([file('f')], () => 'C:/Мои проекты/файл 1.ts')).toBe(
      '@"C:/Мои проекты/файл 1.ts" '
    )
  })
})

describe('clipboardHasImage', () => {
  const item = (type: string): DataTransferItem => ({ type }) as DataTransferItem

  test('картинка в буфере распознаётся', () => {
    expect(clipboardHasImage([item('image/png')])).toBe(true)
  })

  test('только текст — не картинка', () => {
    expect(clipboardHasImage([item('text/plain')])).toBe(false)
  })

  test('пустой буфер — не картинка', () => {
    expect(clipboardHasImage([])).toBe(false)
  })
})
