import { describe, expect, test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiffViewer } from '@renderer/components/viewer/DiffViewer'
import type { GitFileDiff } from '@shared/types'

const html = (diff: GitFileDiff, path = 'a.ts'): string => renderToStaticMarkup(createElement(DiffViewer, { diff, path }))

const text: GitFileDiff = {
  kind: 'text',
  added: 2,
  removed: 1,
  truncatedLines: 0,
  hunks: [
    { oldStart: 3, newStart: 3, lines: [' keep', '-const old = 0', '+const a = 1'] },
    { oldStart: 20, newStart: 21, lines: ['+two', String.fromCharCode(92) + ' No newline at end of file'] }
  ]
}

describe('DiffViewer', () => {
  test('добавленная строка подсвечена: токен keyword', () => {
    expect(html(text)).toContain('<span class="tok-keyword">const</span>')
  })

  test('номера старых и новых строк верны на двух кусках', () => {
    const out = html(text)
    const nums = [...out.matchAll(/<span class="diff-no">(\d*)<\/span><span class="diff-no">(\d*)<\/span>/g)].map((m) => [m[1], m[2]])
    expect(nums).toEqual([
      ['3', '3'],
      ['4', ''],
      ['', '4'],
      ['', '21']
    ])
    expect(out).toContain('No newline at end of file')
  })

  test('обрезанные строки, двоичный и слишком большой', () => {
    expect(html({ ...text, truncatedLines: 1000 } as GitFileDiff)).toContain('и ещё 1000 строк')
    expect(html({ kind: 'binary' })).toContain('Двоичный файл — изменения не показываются.')
    expect(html({ kind: 'tooLarge', bytes: 4 * 1024 * 1024 })).toContain('Изменения слишком большие для просмотра (4,0 МБ).')
    expect(html({ kind: 'error', message: 'сломалось' })).toContain('сломалось')
  })

  test('только чтение: нет полей ввода и contenteditable', () => {
    const out = html(text)
    expect(out).toContain('data-testid="diff-viewer"')
    for (const bad of ['<textarea', '<input', 'contenteditable']) expect(out).not.toContain(bad)
  })
})
