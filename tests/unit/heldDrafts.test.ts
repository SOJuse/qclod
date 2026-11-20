import { describe, expect, test } from 'vitest'
import { HELD_KEY, LONG_DRAFT, holdLongDrafts, loadHeld, restoreDrafts, saveHeld } from '@renderer/state/heldDrafts'

function memory(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map(Object.entries(initial))
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

const long = 'ж'.repeat(LONG_DRAFT + 1)

describe('holdLongDrafts', () => {
  test('длиннее 20 000 символов — в отложенные, короче — в поле', () => {
    const out = holdLongDrafts({ a: long, b: 'коротко', c: 'ж'.repeat(LONG_DRAFT) }, {})
    expect(out.drafts).toEqual({ b: 'коротко', c: 'ж'.repeat(LONG_DRAFT) })
    expect(out.held).toEqual({ a: long })
  })

  test('уже отложенный черновик не теряется: новый длинный идёт после него', () => {
    const out = holdLongDrafts({ a: long }, { a: 'старое' })
    expect(out.held).toEqual({ a: `старое\n\n${long}` })
  })
})

describe('loadHeld / saveHeld', () => {
  test('переживают перезагрузку; мусор в хранилище — пустой список', () => {
    const storage = memory()
    saveHeld(storage, { a: long })
    expect(loadHeld(storage)).toEqual({ a: long })
    expect(loadHeld(memory({ [HELD_KEY]: '{не json' }))).toEqual({})
    expect(loadHeld(memory({ [HELD_KEY]: '{"a": 5, "b": "текст", "c": ""}' }))).toEqual({ b: 'текст' })
    expect(loadHeld(null)).toEqual({})
  })
})

describe('restoreDrafts', () => {
  test('после перезагрузки сторожем длинный черновик откладывается и сохраняется', () => {
    const storage = memory()
    const out = restoreDrafts({ a: long, b: 'коротко' }, storage, '?reloaded=hang')
    expect(out.drafts).toEqual({ b: 'коротко' })
    expect(out.held).toEqual({ a: long })
    expect(loadHeld(storage)).toEqual({ a: long })
  })

  test('обычная перезагрузка (Ctrl+R) возвращает черновик в поле как есть', () => {
    const out = restoreDrafts({ a: long }, memory(), '')
    expect(out.drafts).toEqual({ a: long })
    expect(out.held).toEqual({})
  })

  test('отложенный раньше черновик остаётся отложенным и после обычной перезагрузки', () => {
    const storage = memory()
    saveHeld(storage, { a: long })
    const out = restoreDrafts({ b: 'коротко' }, storage, '')
    expect(out.held).toEqual({ a: long })
    expect(out.drafts).toEqual({ b: 'коротко' })
  })
})

describe('restoreDrafts: Ctrl+R before the field changed', () => {
  test('черновик, который ещё лежит в сохранённом состоянии окна, не возвращается второй раз', () => {
    const storage = memory()
    saveHeld(storage, { a: long })
    expect(restoreDrafts({ a: long }, storage, '').drafts).toEqual({})
  })
})
