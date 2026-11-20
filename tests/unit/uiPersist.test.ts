import { describe, expect, test } from 'vitest'
import { loadUi, serializeUi } from '@renderer/state/uiPersist'
import { hintKeys } from '@renderer/app/shortcuts'

function memory(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map(Object.entries(initial))
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('uiPersist', () => {
  test('черновик и файлы-вложения переживают перезагрузку, панели и активная — нет (их хранит main)', () => {
    const storage = memory()
    storage.setItem(
      'qclod.ui',
      serializeUi({
        draftByTab: { a: 'недописано', b: '' },
        attachmentsByTab: { a: [{ kind: 'file', path: 'C:/x/мой файл.ts' }] },
        paneTabIds: ['a', 'b'],
        activeTabId: 'a'
      } as never)
    )
    const back = loadUi(storage)
    expect(back.draftByTab).toEqual({ a: 'недописано' })
    expect(back.attachmentsByTab).toEqual({ a: [{ kind: 'file', path: 'C:/x/мой файл.ts' }] })
    expect(back).not.toHaveProperty('paneTabIds')
    expect(back).not.toHaveProperty('activeTabId')
    expect(storage.getItem('qclod.ui')).not.toContain('paneTabIds')
    expect(storage.getItem('qclod.ui')).not.toContain('activeTabId')
  })

  test('serializeUi не пишет панели и активную, loadUi старой записи их не читает', () => {
    const text = serializeUi({ draftByTab: {}, attachmentsByTab: {} })
    expect(JSON.parse(text)).toEqual({ draftByTab: {}, attachmentsByTab: {} })
    const old = JSON.stringify({ draftByTab: {}, attachmentsByTab: {}, paneTabIds: ['a'], activeTabId: 'a', splitTabId: 'b' })
    expect(loadUi(memory({ 'qclod.ui': old }))).toEqual({ draftByTab: {}, attachmentsByTab: {} })
  })

  test('картинки из буфера не сохраняются: их содержимое не хранится', () => {
    const image = { kind: 'image', mediaType: 'image/png', file: new Blob(['x']) } as never
    const text = serializeUi({
      draftByTab: {},
      attachmentsByTab: { a: [image, { kind: 'file', path: 'p' }] }
    })
    expect(loadUi(memory({ 'qclod.ui': text })).attachmentsByTab).toEqual({ a: [{ kind: 'file', path: 'p' }] })
    expect(text).not.toContain('image/png')
  })

  test('подготовленная картинка возвращается по копии в pastes', () => {
    const prepared = {
      mediaType: 'image/jpeg',
      thumbnail: 'data:image/png;base64,AA',
      path: 'C:/ud/pastes/paste-1-abcdef01.jpg',
      width: 2000,
      height: 1333
    }
    const image = { kind: 'image' as const, mediaType: 'image/png', file: new Blob(['x']) as File, prepared }
    const text = serializeUi({ draftByTab: {}, attachmentsByTab: { a: [image] } })
    expect(loadUi(memory({ 'qclod.ui': text })).attachmentsByTab).toEqual({
      a: [{ kind: 'image', mediaType: 'image/jpeg', prepared }]
    })
    // A stored thumbnail that is not an inline picture is not shown.
    const forged = text.replace('data:image/png;base64,AA', 'https://evil/x.png')
    expect(loadUi(memory({ 'qclod.ui': forged })).attachmentsByTab).toEqual({})
  })

  test('GIF без миниатюры и размеров тоже возвращается', () => {
    const prepared = { mediaType: 'image/gif', thumbnail: '', path: 'C:/ud/pastes/paste-1-abcdef01.gif', width: 0, height: 0 }
    const text = serializeUi({
      draftByTab: {},
      attachmentsByTab: { a: [{ kind: 'image', mediaType: 'image/gif', prepared }] }
    })
    expect(loadUi(memory({ 'qclod.ui': text })).attachmentsByTab).toEqual({
      a: [{ kind: 'image', mediaType: 'image/gif', prepared }]
    })
  })

  test('пустое или битое хранилище — чистое состояние', () => {
    for (const raw of [undefined, '', '{', '[1]', '{"draftByTab":5}']) {
      const back = loadUi(memory(raw === undefined ? {} : { 'qclod.ui': raw }))
      expect(back).toEqual({ draftByTab: {}, attachmentsByTab: {} })
    }
  })

  test('хранилище недоступно — не падаем', () => {
    const broken = {
      getItem: () => {
        throw new Error('нет')
      },
      setItem: () => undefined
    }
    expect(loadUi(broken).draftByTab).toEqual({})
  })
})

describe('hintKeys', () => {
  test('подпись с клавишей, которой нет среди действий окна', () => {
    expect(hintKeys('Отправить', 'Enter')).toBe('Отправить (Enter)')
  })
})
