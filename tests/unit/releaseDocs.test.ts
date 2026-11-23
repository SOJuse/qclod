import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = resolve(__dirname, '../..')
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n')
const pkg = JSON.parse(read('package.json')) as { version: string }

describe('документы 1.0 (этап 7, задача 17)', () => {
  test('первая строка текста релиза — «# Qclod <версия из package.json>»', () => {
    expect(pkg.version).toMatch(/^1.d+.d+$/)
    expect(read('build/release-notes.md').split('\n')[0]).toBe(`# Qclod ${pkg.version}`)
  })

  test('electron-builder.yml ссылается на build/release-notes.md, и файл есть', () => {
    expect(read('electron-builder.yml')).toMatch(/^releaseInfo:\n {2}releaseNotesFile: build\/release-notes\.md$/m)
    expect(existsSync(resolve(root, 'build/release-notes.md'))).toBe(true)
  })

  test('README: Mac, SSH, голос, шаблоны, Git, «Остановить все»', () => {
    const readme = read('README.md')
    for (const text of [
      'Открыть всё равно',
      'Конфиденциальность и безопасность',
      'SSH',
      'Голосовой ввод',
      'Шаблоны',
      'Git',
      'Остановить все'
    ]) {
      expect(readme, text).toContain(text)
    }
  })

  test('README не предлагает Win+H как основной способ голоса', () => {
    expect(read('README.md')).not.toContain('включает диктовку Windows')
  })

  test('«Что не вошло» в тексте релиза называет граф сабагентов', () => {
    const notes = read('build/release-notes.md')
    const missing = notes.slice(notes.indexOf('## Что не вошло'))
    expect(notes).toContain('## Что не вошло')
    expect(missing).toContain('сабагент')
  })
})
