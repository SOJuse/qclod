import { describe, expect, test } from 'vitest'
import { attachmentsFromClipboard, attachmentsFromDrop } from '../../src/renderer/input/attachments'

/** Stands in for a File without needing a DOM one. */
function file(name: string, type = ''): File {
  return { name, type } as File
}

interface FakeItem {
  kind: 'file' | 'string'
  type: string
  getAsFile: () => File | null
}

function clipboard(options: {
  files?: File[]
  items?: FakeItem[]
  text?: string
}): DataTransfer {
  const files = options.files ?? []
  return {
    files: files as unknown as FileList,
    items: (options.items ?? []) as unknown as DataTransferItemList,
    getData: () => options.text ?? ''
  } as unknown as DataTransfer
}

/** Electron's webUtils, as the preload bridge exposes it. */
function pathsOf(map: Record<string, string>) {
  return (f: File): string | null => map[f.name] ?? null
}

describe('attachmentsFromClipboard', () => {
  test('файл, скопированный в проводнике, становится вложением', () => {
    // v1's bug (spec 6.6): the handler read only text and images, so a file
    // copied in Explorer — which arrives in `files` with empty text — did
    // nothing at all.
    const data = clipboard({ files: [file('auth.ts')], text: '' })

    expect(attachmentsFromClipboard(data, pathsOf({ 'auth.ts': 'C:/проект/auth.ts' }))).toEqual([
      { kind: 'file', path: 'C:/проект/auth.ts' }
    ])
  })

  test('несколько файлов дают несколько вложений', () => {
    const data = clipboard({ files: [file('a.ts'), file('b.ts')] })

    expect(
      attachmentsFromClipboard(data, pathsOf({ 'a.ts': 'C:/p/a.ts', 'b.ts': 'C:/p/b.ts' }))
    ).toEqual([
      { kind: 'file', path: 'C:/p/a.ts' },
      { kind: 'file', path: 'C:/p/b.ts' }
    ])
  })

  test('путь с пробелами и кириллицей остаётся одним вложением', () => {
    const data = clipboard({ files: [file('файл 1.txt')] })

    expect(
      attachmentsFromClipboard(data, pathsOf({ 'файл 1.txt': 'C:/Мои файлы/файл 1.txt' }))
    ).toEqual([{ kind: 'file', path: 'C:/Мои файлы/файл 1.txt' }])
  })

  test('картинка из буфера становится вложением-изображением, а не путём', () => {
    const image = file('снимок.png', 'image/png')
    const data = clipboard({
      files: [image],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }]
    })

    const result = attachmentsFromClipboard(data, () => null)
    expect(result).toEqual([{ kind: 'image', mediaType: 'image/png', file: image }])
  })

  test('картинка из буфера без файла на диске всё равно доходит', () => {
    // Pasted from a screenshot tool: the clipboard has an image item and a
    // File with no path, and the image must still reach the agent.
    const image = file('буфер.png', 'image/png')
    const data = clipboard({ files: [image] })

    expect(attachmentsFromClipboard(data, () => null)).toEqual([
      { kind: 'image', mediaType: 'image/png', file: image }
    ])
  })

  test('файлы без пути пропускаются, а не вставляются именем', () => {
    // A file dragged out of an archive or a browser has no path on disk.
    const data = clipboard({ files: [file('нет-пути.ts')] })

    expect(attachmentsFromClipboard(data, () => null)).toEqual([])
  })

  test('обычный текст вложением не становится', () => {
    expect(attachmentsFromClipboard(clipboard({ text: 'просто текст' }), () => null)).toEqual([])
    expect(attachmentsFromClipboard(null, () => null)).toEqual([])
  })
})

describe('attachmentsFromDrop', () => {
  test('перетянутые файлы становятся вложениями', () => {
    const result = attachmentsFromDrop(
      [file('a.ts'), file('картинка.png', 'image/png')],
      pathsOf({ 'a.ts': 'C:/p/a.ts', 'картинка.png': 'C:/p/картинка.png' })
    )

    expect(result).toEqual([
      { kind: 'file', path: 'C:/p/a.ts' },
      { kind: 'file', path: 'C:/p/картинка.png' }
    ])
  })

  test('картинка без пути на диске уходит содержимым', () => {
    const image = file('буфер.png', 'image/png')
    expect(attachmentsFromDrop([image], () => null)).toEqual([
      { kind: 'image', mediaType: 'image/png', file: image }
    ])
  })

  test('пустой список даёт пустой результат', () => {
    expect(attachmentsFromDrop([], () => null)).toEqual([])
  })
})
