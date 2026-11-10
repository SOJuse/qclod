import { describe, expect, test } from 'vitest'
import {
  attachmentLabel,
  attachmentsFromClipboard,
  attachmentsFromDrop,
  isPreparing,
  materialize,
  prepareAttachment,
  queuedSendStep,
  type PendingAttachment
} from '../../src/renderer/input/attachments'

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

describe('вставленная картинка до отправки', () => {
  const prepared = {
    mediaType: 'image/jpeg',
    thumbnail: 'data:image/png;base64,AA',
    path: 'C:/ud/pastes/paste-1-abcdef01.jpg',
    width: 2000,
    height: 1333
  }

  test('уходит такой, какой её подготовил main; с ошибкой или неготовая — не уходит', () => {
    const pending: PendingAttachment[] = [
      { kind: 'image', mediaType: 'image/png', prepared },
      { kind: 'image', mediaType: 'image/png', error: 'Не похоже на картинку' },
      { kind: 'image', mediaType: 'image/png' },
      { kind: 'file', path: 'C:/p/a.ts' }
    ]
    expect(materialize(pending)).toEqual([
      { kind: 'image', ...prepared, dataBase64: '' },
      { kind: 'file', path: 'C:/p/a.ts' }
    ])
    expect(pending.map(isPreparing)).toEqual([false, false, true, false])
  })

  test('плашка называет размер снимка, ошибку или ожидание', () => {
    expect(attachmentLabel({ kind: 'image', mediaType: 'image/png', prepared })).toBe('Снимок 2000×1333')
    expect(attachmentLabel({ kind: 'image', mediaType: 'image/png', error: 'Картинка слишком большая' })).toBe(
      'Картинка слишком большая'
    )
    expect(attachmentLabel({ kind: 'image', mediaType: 'image/png' })).toBe('Готовлю снимок…')
  })

  test('картинка без файла не готовится: ошибка, main не спрашивается', async () => {
    let asked = false
    const out = await prepareAttachment({ kind: 'image', mediaType: 'image/png' }, async () => {
      asked = true
      return prepared
    })
    expect(out).toEqual({ error: 'Не получилось прочитать картинку' })
    expect(asked).toBe(false)
  })
})

describe('отправка, отложенная до готовности снимка', () => {
  const ready = {
    kind: 'image' as const,
    mediaType: 'image/png',
    prepared: { mediaType: 'image/png', thumbnail: 'data:image/png;base64,AA', path: 'C:/p.png', width: 1, height: 1 }
  }
  const waiting = { kind: 'image' as const, mediaType: 'image/png' }
  const failed = { kind: 'image' as const, mediaType: 'image/png', error: 'Не похоже на картинку' }

  test('ничего не отложено — ничего не делать', () => {
    expect(queuedSendStep(false, [waiting])).toBe('none')
  })

  test('снимок ещё готовится — ждать; готов — отправить', () => {
    expect(queuedSendStep(true, [ready, waiting])).toBe('wait')
    expect(queuedSendStep(true, [ready, { kind: 'file', path: 'C:/a.ts' }])).toBe('send')
  })

  test('снимок не удался — отложенная отправка отменяется, а не уходит без него', () => {
    expect(queuedSendStep(true, [ready, failed])).toBe('cancel')
  })

  test('снимок убрали крестиком, пока ждали, — отправка отменяется', () => {
    expect(queuedSendStep(true, [])).toBe('cancel')
    expect(queuedSendStep(true, [{ kind: 'file', path: 'C:/a.ts' }])).toBe('cancel')
  })

  test('у GIF без размеров плашка — просто «Снимок»', () => {
    expect(attachmentLabel({ ...ready, prepared: { ...ready.prepared, width: 0, height: 0 } })).toBe('Снимок')
  })
})
