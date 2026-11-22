import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEMPLATES_FILE, TemplateLibrary, loadTemplates } from '@main/store/templatesStore'
import { TEMPLATE_LIMITS } from '@shared/types'

let dir: string
let clock = 1000
let seq = 0
const deps = { now: () => clock, newId: () => `id${++seq}` }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qclod-templates-'))
  clock = 1000
  seq = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function file(): string {
  return join(dir, TEMPLATES_FILE)
}

describe('TemplateLibrary', () => {
  test('save и list переживают перезагрузку из файла', () => {
    const lib = new TemplateLibrary(dir, deps)
    lib.save({ title: 'Ревью', body: 'Проверь {{ветку}}' })
    clock = 2000
    lib.save({ title: 'Тесты', body: 'Напиши тесты', origin: 'harvest' })

    const again = new TemplateLibrary(dir, deps)
    expect(again.list().map((t) => t.title)).toEqual(['Тесты', 'Ревью'])
    expect(again.list()[0]).toMatchObject({ origin: 'harvest', createdAt: 2000, updatedAt: 2000 })
    expect(loadTemplates(dir)).toHaveLength(2)
    const stored = JSON.parse(readFileSync(file(), 'utf8'))
    expect(stored.version).toBe(1)
    expect(existsSync(`${file()}.tmp`)).toBe(false)
  })

  test('пустое название берётся из первой строки текста', () => {
    const lib = new TemplateLibrary(dir, deps)
    const body = `\n  ${'длинная первая строка '.repeat(5)}\nвторая`
    const saved = lib.save({ title: '  ', body })
    expect(saved).not.toBeNull()
    expect(saved!.title.length).toBeLessThanOrEqual(60)
    expect(saved!.title.startsWith('длинная первая строка')).toBe(true)
    expect(saved!.title.endsWith('…')).toBe(true)
  })

  test('save с id обновляет, createdAt прежний', () => {
    const lib = new TemplateLibrary(dir, deps)
    const first = lib.save({ title: 'А', body: 'раз' })!
    clock = 5000
    const updated = lib.save({ id: first.id, title: 'Б', body: 'два' })!
    expect(updated).toMatchObject({ id: first.id, title: 'Б', body: 'два', createdAt: 1000, updatedAt: 5000 })
    expect(lib.list()).toHaveLength(1)

    const stranger = lib.save({ id: 'nobody', title: 'В', body: 'три' })!
    expect(stranger.id).not.toBe('nobody')
    expect(lib.list()).toHaveLength(2)
  })

  test('501-й шаблон не сохраняется, save даёт null', () => {
    const lib = new TemplateLibrary(dir, deps)
    for (let i = 0; i < TEMPLATE_LIMITS.maxCount; i++) {
      expect(lib.saveMany([{ title: `t${i}`, body: `b${i}` }])).toBe(1)
    }
    expect(lib.list()).toHaveLength(500)
    expect(lib.save({ title: 'лишний', body: 'x' })).toBeNull()
    expect(lib.saveMany([{ title: 'лишний', body: 'x' }])).toBe(0)
    // Editing an existing one still works at the limit.
    const some = lib.list()[0]!
    expect(lib.save({ id: some.id, title: 'правка', body: 'y' })).not.toBeNull()
  })

  test('битый файл переименовывается в .bad, а не затирается', () => {
    writeFileSync(file(), '{oops', 'utf8')
    expect(loadTemplates(dir)).toEqual([])
    expect(readFileSync(`${file()}.bad`, 'utf8')).toBe('{oops')

    writeFileSync(file(), '{oops', 'utf8')
    const lib = new TemplateLibrary(dir, deps)
    expect(lib.list()).toEqual([])
    lib.save({ title: 'новый', body: 'текст' })
    const stored = JSON.parse(readFileSync(file(), 'utf8'))
    expect(stored.templates).toHaveLength(1)
    expect(readFileSync(`${file()}.bad`, 'utf8')).toBe('{oops')
  })

  test('файл не той формы тоже уходит в .bad', () => {
    writeFileSync(file(), JSON.stringify({ version: 1, templates: 'нет' }), 'utf8')
    expect(loadTemplates(dir)).toEqual([])
    expect(existsSync(`${file()}.bad`)).toBe(true)
  })

  test('запись с неверным полем пропускается, остальные читаются', () => {
    const good = { id: 'a', title: 'Хороший', body: 'текст', origin: 'manual', createdAt: 1, updatedAt: 2 }
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        templates: [
          good,
          { ...good, id: 'b', body: 42 },
          { ...good, id: 'c', origin: 'чужой' },
          { ...good, id: 'bad id with spaces' },
          null
        ]
      }),
      'utf8'
    )
    expect(loadTemplates(dir).map((t) => t.id)).toEqual(['a'])
    expect(existsSync(`${file()}.bad`)).toBe(false)
  })

  test('remove и onChange', () => {
    const lib = new TemplateLibrary(dir, deps)
    const seen: number[] = []
    const off = lib.onChange((list) => seen.push(list.length))
    const t = lib.save({ title: 'А', body: 'раз' })!
    expect(lib.remove('nobody')).toBe(false)
    expect(lib.remove(t.id)).toBe(true)
    off()
    lib.save({ title: 'Б', body: 'два' })
    expect(seen).toEqual([1, 0])
    expect(new TemplateLibrary(dir, deps).list()).toHaveLength(1)
  })
})
