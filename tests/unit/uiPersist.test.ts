import { describe, expect, test } from 'vitest'
import { loadUi, serializeUi } from '@renderer/state/uiPersist'
import { hintKeys } from '@renderer/app/shortcuts'

function memory(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map(Object.entries(initial))
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('uiPersist', () => {
  test('черновик, файлы-вложения, вторая панель и активная вкладка переживают перезагрузку', () => {
    const storage = memory()
    storage.setItem(
      'qclod.ui',
      serializeUi({
        draftByTab: { a: 'недописано', b: '' },
        attachmentsByTab: { a: [{ kind: 'file', path: 'C:/x/мой файл.ts' }] },
        splitTabId: 'b',
        activeTabId: 'a'
      })
    )
    const back = loadUi(storage)
    expect(back.draftByTab).toEqual({ a: 'недописано' })
    expect(back.attachmentsByTab).toEqual({ a: [{ kind: 'file', path: 'C:/x/мой файл.ts' }] })
    expect(back.splitTabId).toBe('b')
    expect(back.activeTabId).toBe('a')
  })

  test('картинки из буфера не сохраняются: их содержимое не хранится', () => {
    const image = { kind: 'image', mediaType: 'image/png', file: new Blob(['x']) } as never
    const text = serializeUi({
      draftByTab: {},
      attachmentsByTab: { a: [image, { kind: 'file', path: 'p' }] },
      splitTabId: null,
      activeTabId: ''
    })
    expect(loadUi(memory({ 'qclod.ui': text })).attachmentsByTab).toEqual({ a: [{ kind: 'file', path: 'p' }] })
    expect(text).not.toContain('image/png')
  })

  test('пустое или битое хранилище — чистое состояние', () => {
    for (const raw of [undefined, '', '{', '[1]', '{"draftByTab":5}']) {
      const back = loadUi(memory(raw === undefined ? {} : { 'qclod.ui': raw }))
      expect(back).toEqual({ draftByTab: {}, attachmentsByTab: {}, splitTabId: null, activeTabId: '' })
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
