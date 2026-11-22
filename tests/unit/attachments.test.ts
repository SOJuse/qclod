import { describe, expect, test } from 'vitest'
import {
  attachmentLabel,
  attachmentsFromClipboard,
  attachmentsFromDrop,
  draftWithReturned,
  isPreparing,
  materialize,
  pendingFromSent,
  prepareAttachment,
  prepareRemoteFile,
  needsUpload,
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

  test('вкладка умерла, пока ждали снимок, — отправка отменяется, текст остаётся', () => {
    expect(queuedSendStep(true, [ready], true)).toBe('cancel')
    expect(queuedSendStep(true, [ready, waiting], true)).toBe('cancel')
    expect(queuedSendStep(false, [ready], true)).toBe('none')
  })

  test('снимок убрали крестиком, пока ждали, — отправка отменяется', () => {
    expect(queuedSendStep(true, [])).toBe('cancel')
    expect(queuedSendStep(true, [{ kind: 'file', path: 'C:/a.ts' }])).toBe('cancel')
  })

  test('у GIF без размеров плашка — просто «Снимок»', () => {
    expect(attachmentLabel({ ...ready, prepared: { ...ready.prepared, width: 0, height: 0 } })).toBe('Снимок')
  })
})

describe('очередь возвращается в поле', () => {
  test('файл — путём, картинка — подготовленной копией и байтами', async () => {
    expect(pendingFromSent({ kind: 'file', path: 'C:/p/a.ts' })).toEqual({ kind: 'file', path: 'C:/p/a.ts' })

    const back = pendingFromSent({
      kind: 'image',
      mediaType: 'image/png',
      dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
      path: 'C:/u/pastes/1.png',
      thumbnail: 'data:image/png;base64,AA',
      width: 64,
      height: 48
    })
    expect(back).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      prepared: { mediaType: 'image/png', path: 'C:/u/pastes/1.png', thumbnail: 'data:image/png;base64,AA', width: 64, height: 48 }
    })
    const bytes = (back as { file: File }).file
    expect(bytes.type).toBe('image/png')
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([1, 2, 3])
    // Ready to go again, not «Готовлю снимок…».
    expect(isPreparing(back)).toBe(false)
  })

  test('картинка без копии и без байтов — плашка с ошибкой', () => {
    expect(pendingFromSent({ kind: 'image', mediaType: 'image/png', dataBase64: '' })).toEqual({
      kind: 'image',
      mediaType: 'image/png',
      error: 'Не получилось прочитать картинку'
    })
  })

  test('тексты очереди — перед набранным, через пустую строку', () => {
    expect(draftWithReturned(['два', 'три'], 'уже набрано')).toBe('два\n\nтри\n\nуже набрано')
    expect(draftWithReturned(['два'], '')).toBe('два')
    expect(draftWithReturned([], 'как было')).toBe('как было')
  })
})

describe('этап 6: файл серверного чата', () => {
  test('prepareRemoteFile: успех даёт серверный путь, и в сообщение уходит он', async () => {
    const done = await prepareRemoteFile({ kind: 'file', path: 'C:/doc/a.pdf' }, async () => ({ remotePath: '/home/u/.qclod/uploads/s1/1-a.pdf' }))
    expect(done).toEqual({ kind: 'file', path: 'C:/doc/a.pdf', remotePath: '/home/u/.qclod/uploads/s1/1-a.pdf' })
    expect(materialize([done])).toEqual([{ kind: 'file', path: '/home/u/.qclod/uploads/s1/1-a.pdf' }])
    expect(attachmentLabel(done)).toBe('a.pdf')
  })

  test('ошибка даёт error, и materialize вложение не включает', async () => {
    const failed = await prepareRemoteFile({ kind: 'file', path: 'C:/doc/a.pdf' }, async () => ({
      error: 'Файл больше 100 МБ — на сервер не загружается'
    }))
    expect(failed).toEqual({ kind: 'file', path: 'C:/doc/a.pdf', error: 'Файл больше 100 МБ — на сервер не загружается' })
    expect(materialize([failed])).toEqual([])
    expect(attachmentLabel(failed)).toBe('Файл больше 100 МБ — на сервер не загружается')
    const thrown = await prepareRemoteFile({ kind: 'file', path: 'C:/doc/a.pdf' }, async () => {
      throw new Error('нет связи')
    })
    expect(thrown).toMatchObject({ error: 'Не удалось загрузить на сервер: нет связи' })
  })

  test('пока файл грузится, отправка ждёт; загрузился — уходит; не загрузился — отменяется', () => {
    const uploading: PendingAttachment = { kind: 'file', path: 'C:/a.txt', uploading: true }
    expect(isPreparing(uploading)).toBe(true)
    expect(attachmentLabel(uploading)).toBe('a.txt — загружаю на сервер…')
    expect(materialize([uploading])).toEqual([])
    expect(queuedSendStep(true, [uploading])).toBe('wait')
    expect(queuedSendStep(true, [{ kind: 'file', path: 'C:/a.txt', remotePath: '/srv/a.txt' }])).toBe('send')
    expect(queuedSendStep(true, [{ kind: 'file', path: 'C:/a.txt', error: 'нет' }])).toBe('cancel')
  })

  test('needsUpload: только не начатый файл', () => {
    expect(needsUpload({ kind: 'file', path: 'C:/a' })).toBe(true)
    expect(needsUpload({ kind: 'file', path: 'C:/a', uploading: true })).toBe(false)
    expect(needsUpload({ kind: 'file', path: 'C:/a', remotePath: '/x' })).toBe(false)
    expect(needsUpload({ kind: 'image', mediaType: 'image/png' })).toBe(false)
  })
})
