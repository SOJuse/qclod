import { describe, expect, test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { viewLayerFor } from '@renderer/paths/viewable'
import { FileBody } from '@renderer/components/viewer/FileViewer'

describe('«Посмотреть» в меню пути', () => {
  test('src/a.ts:3 ставит слой file со строкой 3', () => {
    expect(viewLayerFor({ raw: 'src/a.ts:3', absPath: 'C:\\p\\src\\a.ts', isDir: false })).toEqual({
      kind: 'file',
      path: 'C:\\p\\src\\a.ts',
      line: 3
    })
    // The resolver's own line wins when it has one.
    expect(viewLayerFor({ raw: 'src/a.ts', absPath: 'C:\\p\\src\\a.ts', isDir: false, line: 9 })?.line).toBe(9)
    expect(viewLayerFor({ raw: 'src/a.ts', absPath: 'C:\\p\\src\\a.ts', isDir: false })).toEqual({
      kind: 'file',
      path: 'C:\\p\\src\\a.ts'
    })
  })

  test('.exe, картинка, PDF и папка — без «Посмотреть»', () => {
    for (const absPath of ['C:\\p\\setup.exe', 'C:\\p\\a.png', 'C:\\p\\a.pdf', 'C:\\p\\Makefile', 'C:\\p\\a.svg']) {
      expect(viewLayerFor({ raw: absPath, absPath, isDir: false })).toBeNull()
    }
    expect(viewLayerFor({ raw: 'src', absPath: 'C:\\p\\src.ts', isDir: true })).toBeNull()
  })
})

describe('FileBody', () => {
  const html = (file: Parameters<typeof FileBody>[0]['file'], line?: number): string =>
    renderToStaticMarkup(createElement(FileBody, { file, path: 'a.ts', line }))

  test('текст с подсветкой, номерами и отмеченной строкой; без полей ввода', () => {
    const out = html({ kind: 'text', text: 'export const a = 1\n// two\n// three\n', size: 34, truncated: false }, 3)
    expect(out).toContain('<span class="tok-keyword">export</span>')
    expect(out).toContain('data-line="3"')
    expect(out).toMatch(/is-target"[^>]*data-line="3"/)
    expect(out.match(/data-line=/g)).toHaveLength(3)
    for (const bad of ['<textarea', '<input', 'contenteditable']) expect(out).not.toContain(bad)
  })

  test('двоичный, пропавший, ошибка', () => {
    expect(html({ kind: 'binary', size: 5 })).toContain('Двоичный файл')
    expect(html({ kind: 'missing' })).toContain('Файла больше нет.')
    expect(html({ kind: 'error', message: 'нет доступа' })).toContain('нет доступа')
    expect(html(null)).toContain('Загружаю…')
  })
})
